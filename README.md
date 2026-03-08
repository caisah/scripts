# Scripts

## LinkedIn profile fetch

Install:

```bash
bun install
```

Required environment variables:

- `LINKEDIN_PROFILE_URL`

Optional environment variables:

- `LINKEDIN_USER_DATA_DIR` - browser user data dir. Default: `~/Library/Application Support/Google/Chrome`
- `LINKEDIN_PROFILE_DIR` - browser profile dir inside that user data dir. Default: `Default`

Run:

```bash
bun run linkedin:profile
```

Output:

- `scripts/output/linkedin-profile.json`

Limits:

- This is a minimal script. It only extracts a few visible profile fields.
- It reuses the LinkedIn session cookies from your local Chrome profile instead of logging in with a password.
- Chrome should be fully closed before running it, or the profile may be locked.
- LinkedIn may block session reuse or change selectors without notice.
