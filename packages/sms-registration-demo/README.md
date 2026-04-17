# SMS Registration Demo

This demo plugin adds a separate phone-based registration flow at `/sms-register`.

Highlights:
- Saves the phone number into the user document.
- Sends a six-digit verification code.
- Keeps an Aliyun SMS integration entry point in `index.ts` for later replacement.
- Uses demo logging instead of a real SMS provider for now.
