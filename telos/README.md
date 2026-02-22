# TELOS Personal Context

TELOS gives your AI persistent context about who you are — your mission, goals, beliefs, challenges, and more — so every response is aligned with your actual life.

## How It Works

The `telos/` directory contains template files with placeholder content. During setup, these are copied to `data/telos/` where you customize them with your own content. The bot loads all `.md` files from `data/telos/` at runtime and injects them as context into every prompt.

## Files

| File | Purpose |
|------|---------|
| `MISSION.md` | Your life mission and core purpose |
| `GOALS.md` | Current goals (personal + professional) |
| `BELIEFS.md` | Values, mental models, principles |
| `CHALLENGES.md` | Current obstacles and growth areas |
| `INTERESTS.md` | Hobbies, interests, learning areas |
| `HISTORY.md` | Key background and life context |
| `KPIs.md` | What "performing well" looks like for you |

## Getting Started

1. Copy templates to your data directory:
   ```bash
   mkdir -p data/telos && cp telos/*.md data/telos/
   ```

2. Edit the files in `data/telos/` with your own content. Start with `MISSION.md` and `GOALS.md` — these have the highest impact on response quality.

3. The bot automatically loads these files on every prompt. No configuration needed.

## Tips

- You don't need to fill in every file. Empty or missing files are silently skipped.
- Keep each file focused and concise. The AI reads all of them on every message.
- Update files as your life changes — goals shift, challenges resolve, new interests emerge.
- The `data/telos/` directory is gitignored, so your personal content stays private.
