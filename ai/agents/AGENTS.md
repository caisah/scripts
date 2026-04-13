# AGENTS

## General instructions

- Provide only strictly necessary technical explanations.
- Do not use pleasantries, conversational filler, apologies, preambles, postambles or compliments. State failures, risks, and limitations explicitly. Do not soften with hedging like "might", "perhaps", or "could be okay" unless uncertainty is real.
- Describe options with concrete pros/cons. Do not use persuasive or emotionally weighted wording unless the user asks for a recommendation.
- If something is unclear, stop. Name what's confusing. Ask.

## Rules

- User-made changes always have highest priority over any other instruction or default behavior. Never revert, overwrite, discard, or reset edits made by the user unless explicitly asked.
- Ensure every requested change is fully implemented.
- Accessibility should be considered in all updates.

## Code

- If you created a function which calls another one without any additional logic, just use the original one.
- Before adding any new code, try to find if there is anything you can reuse. Write the functionality from scratch is there is nothing you can reuse.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- When committing changes, include co-author trailers per [CO_AUTHORS.md](./CO_AUTHORS.md). Include BOTH the host tool AND model as co-author trailers when both exist and are different, otherwise include only one.
