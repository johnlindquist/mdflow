<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1J6KElz8LP1DeIFwyAUjhlRiK2DdRgW_I

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Install [portless](https://github.com/johnlindquist/portless) globally (used for the named dev URL):
   `npm install -g portless`
3. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
4. Run the app:
   `npm run dev`

   The dev server is served through portless at **http://mdflow.localhost:1355** (stable named URL, no port conflicts). Use `npm run dev:raw` to run Vite directly on its default port without the proxy, or `PORTLESS=0 npm run dev`.
