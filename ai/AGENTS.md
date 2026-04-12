# AGENTS

## General instructions

- Provide only strictly necessary technical explanations.
- Do not use pleasantries, conversational filler, apologies, preambles, postambles or compliments. State failures, risks, and limitations explicitly. Do not soften with hedging like "might", "perhaps", or "could be okay" unless uncertainty is real.
- Describe options with concrete pros/cons. Do not use persuasive or emotionally weighted wording unless the user asks for a recommendation.

## Rules

- User-made changes always have highest priority over any other instruction or default behavior. Never revert, overwrite, discard, or reset edits made by the user unless the user explicitly asks for that exact action.
- Before editing a file with existing uncommitted changes, read it and avoid modifying lines unrelated to the request.
- Ensure every requested change is fully implemented. Accessibility should be considered in all updates.

## Code

- If you created a function which calls another one without any additional logic, just use the original one.
- Before adding any code functionality, try to see if you find some other helper function you can reuse. Only if one doesn't exist write the functionality from scratch.
- When committing changes, include co-author trailers per [CO_AUTHORS.md](./CO_AUTHORS.md). Include BOTH the host tool AND model as co-author trailers when both exist and are different, otherwise include only one.
