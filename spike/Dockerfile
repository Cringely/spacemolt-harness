# Spike: prove subscription-auth headless Claude works in a container.
# node base because the claude CLI is an npm package; final harness image
# composition (bun + claude) is a follow-up finding of this spike.
FROM node:22-bookworm-slim
ARG CLAUDE_VERSION
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}
ENTRYPOINT ["claude"]
