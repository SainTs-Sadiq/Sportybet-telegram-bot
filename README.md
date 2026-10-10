# SportyBet Telegram Bot

Telegram bot for SportyBet Nigeria football fixtures, markets and odds. It generates downloadable PDF and XLSX reports.

## Commands
- `/start`
- `/today`
- `/tomorrow`
- `/pdf`
- `/pdf_tomorrow`
- `/excel`
- `/excel_tomorrow`

## Deploy
1. Import this GitHub repository into Vercel.
2. Add environment variables: `TELEGRAM_BOT_TOKEN`, `BOT_SECRET`, `SPORTYBET_API_BASE_URL=https://www.sportybet.com`, `SPORTYBET_REGION=ng`, `REPORT_TIMEZONE=Africa/Lagos`.
3. Deploy.
4. Open `https://YOUR-PROJECT.vercel.app/api/setup` once to register the Telegram webhook.
5. Open the bot in Telegram and send `/start`.

The bot only retrieves data and generates reports; it does not place wagers. SportyBet endpoints used here are undocumented website endpoints and may change.

## Historical team-form analysis

The AI analysis and target-odds builder can use Football Charts historical results instead of requesting per-fixture predictions from API-Football. The bot computes recent W/D/L form, goals for/against, points per game, home/away splits, and an independent Poisson-style score model, then blends that model with normalized SportyBet 1X2 market probabilities. Gemini ranks only the resulting candidate data.

Historical results are cached in a private Vercel Blob store (`sportybet-team-history`) and in memory for repeated reads. The store is connected to this Vercel project and supplies `BLOB_READ_WRITE_TOKEN` automatically. The data provider covers lower divisions as well as major leagues, but coverage varies by competition and season. If the provider cannot match a SportyBet league/team or lacks enough completed results, the bot labels that selection as market-only rather than inventing form.

Model output is an estimate, not a guarantee. Injuries and player availability are not included in this results-only model. The first request for an uncached league can take longer because its results must be downloaded and cached.
