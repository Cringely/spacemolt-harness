// Net-trip profitability estimator (issue #112, operator directive: judge
// trips on NET profit -- revenue minus the full cost of going -- never on the
// gross sale price alone).
//
// THE FEE MODEL, grounded in the vendored reference (AGENTS.md binding rule:
// cite or don't ship). What a selling trip actually costs:
//
//   FUEL -- the real cost of a trip. find_route reports the trip's fuel in
//   fuel UNITS (`estimated_fuel`, plus `fuel_per_jump`: travel.md:28; the
//   live-captured response shape is documented at executor.ts's nextHop()).
//   Converting units to credits needs a price: station fuel is priced by tank
//   fill, 2cr/unit at >=90% full and RISING as the tank empties
//   (upstream/guides/fuel.md:115-120), fuel cells bottom out at 43cr/20units
//   = 2.15cr/unit (fuel.md:52), and empires add a per-unit fuel tax ON TOP
//   (travel.md:65). So 2cr/unit is the documented global MINIMUM -- see
//   FUEL_PRICE_FLOOR_CR below.
//
//   MARKET TRANSACTION FEE -- an instant sell/buy against the standing book
//   pays NO fee (markets.md:18 "Instant fills incur no fees"); the only
//   market fee is the 1% listing fee on the portion of an order that RESTS on
//   the book (markets.md:35). See LISTING_FEE_BPS.
//
//   CUSTOMS / BORDER -- there is NO flat border-crossing fee. Customs patrols
//   scan at borders and seize + fine CONTRABAND only (police.md:67-75); a
//   clean hold crosses free, and evading with a clean hold is not even a
//   crime (police.md:73). Contraband fine multipliers are empire policy read
//   live via get_empire_info (police.md:69), so contraband RISK stays an
//   advisory (digest prose), never a deterministic number here.
//
//   EXCLUDED, with receipts -- not modeled rather than guessed (#112's
//   ASSUMED-gap rule):
//     - docking fees: documented NOWHERE in the vendored reference; the
//       station income list (economy.md:83) names refueling, repairs,
//       facility construction and listing fees -- docking is absent.
//     - sales tax: charged at BUY time at the buying station's empire rate
//       (economy.md:29) -- a cost of purchases, not of selling trips.
//     - income tax: a WEEKLY assessment on accrued earnings (economy.md:23-25),
//       not a per-trip marginal fee; modeling it per-trip would double-count
//       a cost the weekly cycle already owns.
//
// The estimator is a PURE function of explicit inputs and fails OPEN the #94
// way: any missing number makes the estimate UNKNOWN (`known: false`, naming
// what was missing) -- never a guessed verdict.
//
// CONSUMER STATUS (PR #361 review, REVISE): the digest's net-profit verdict
// interpolates the constants below; no production code calls estimateNetTrip
// yet. The first cut wired it into an executor travel_to guard priced at
// catalog base_value -- rejected in review because catalog value does not
// BOUND revenue in a player-driven market (markets.md:3,7: no global fixed
// price; station price gaps are the arbitrage profession), so the "provably
// lossy" premise failed and the guard could block profit (#155, conservative
// suppression). The function stays as the fee-model SSOT, unit-tested, for a
// caller that can feed it a KNOWN revenue number (a live destination bid, if
// a producer for one ever lands).

/**
 * Cheapest possible credits-per-fuel-unit anywhere in the game: station fuel
 * at a >=90%-full tank (fuel.md:115-117); every other source -- lower tank
 * bands, fuel cells (43cr/20 = 2.15, fuel.md:52), empire fuel tax on top
 * (travel.md:65) -- costs MORE. Multiplying fuel units by this floor gives a
 * lower bound on the trip's fuel cost, so "revenue < floor cost" is a
 * KNOWN-negative verdict, not an estimate that could false-fire.
 */
export const FUEL_PRICE_FLOOR_CR = 2;

/** The exchange's 1% listing fee, book-resting portion only (markets.md:35). */
export const LISTING_FEE_BPS = 100;

/** One sale leg: an expected fill at a known per-unit price. */
export interface NetTripSale {
  /** Credits per unit -- a real bid (view_market) or the catalog base_value. */
  pricePerUnitCr?: number;
  quantity?: number;
}

export interface NetTripInput {
  /** Sales expected at the destination (bid x qty per markets.md:21,150). */
  sales?: NetTripSale[];
  /** Mission payout collected by the trip, when that is the revenue. */
  missionPayoutCr?: number;
  /** Fuel UNITS across every leg being judged (find_route, travel.md:28). */
  fuelUnits?: number;
  /** Credits per fuel unit (fuel.md:115-120 bands; FUEL_PRICE_FLOOR_CR is the floor). */
  fuelPricePerUnitCr?: number;
  /** Order value that will REST on the book, if listing instead of instant-selling. */
  listedValueCr?: number;
}

export type NetTripEstimate =
  /** A number was missing -- no verdict, never a guess (#94). */
  | { known: false; missing: string[] }
  | { known: true; netCr: number; revenueCr: number; fuelCostCr: number; listingFeeCr: number };

/**
 * Expected revenue MINUS trip cost, or UNKNOWN when any input is missing.
 * Pure -- no queries, no catalog reads; the caller owns sourcing the numbers.
 * The listing fee rounds DOWN (rounding is uncaptured upstream; flooring keeps
 * the whole estimate a lower bound on cost when the caller feeds floor inputs,
 * so a negative verdict stays safe under either rounding).
 */
export function estimateNetTrip(input: NetTripInput): NetTripEstimate {
  const missing: string[] = [];
  const sales = input.sales ?? [];
  if (!sales.length && input.missionPayoutCr === undefined) {
    missing.push("revenue (no sales, no missionPayoutCr)");
  }
  sales.forEach((s, i) => {
    if (s.pricePerUnitCr === undefined) missing.push(`sales[${i}].pricePerUnitCr`);
    if (s.quantity === undefined) missing.push(`sales[${i}].quantity`);
  });
  if (input.fuelUnits === undefined) missing.push("fuelUnits");
  if (input.fuelPricePerUnitCr === undefined) missing.push("fuelPricePerUnitCr");
  if (missing.length) return { known: false, missing };

  const revenueCr =
    sales.reduce((sum, s) => sum + s.pricePerUnitCr! * s.quantity!, 0) +
    (input.missionPayoutCr ?? 0);
  const fuelCostCr = input.fuelUnits! * input.fuelPricePerUnitCr!;
  const listingFeeCr = Math.floor(((input.listedValueCr ?? 0) * LISTING_FEE_BPS) / 10000);
  return {
    known: true,
    netCr: revenueCr - fuelCostCr - listingFeeCr,
    revenueCr,
    fuelCostCr,
    listingFeeCr,
  };
}
