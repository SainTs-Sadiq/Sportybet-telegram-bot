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