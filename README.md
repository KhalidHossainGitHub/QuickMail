# QuickMail

**QuickMail** is a Chrome extension that adds an AI writing assistant directly inside Gmail's compose window. Tell it what you want to say and it drafts a polished email using the thread, your recipients, and your account name, with a greeting, clear body, and sign-off. For new messages, you can optionally generate a subject line without overwriting one you have already written. Your OpenAI API key is stored in Chrome and sent only to OpenAI, with no backend server.

<p align="center">
  <img width="932" alt="QuickMail Preview" src="public/QuickMail-Preview.png">
  <br>
  <b>Figure 1: QuickMail Preview Design</b>
</p>

## Project Overview

QuickMail enables Gmail users to:

- **Draft from the Compose Window**: Click **Write with AI** next to **Send** in any Gmail compose or reply window to open a compact writing popover without leaving the thread.
- **Use Thread Context Automatically**: The extension reads the current email subject and message bodies (up to 6,000 characters) and sends them to the model so replies stay relevant to the conversation.
- **Describe What You Want**: Type a short instruction — e.g. "confirm Thursday at 2pm and ask for the agenda" — and QuickMail turns it into a full draft.
- **Generate Structured Emails**: Drafts follow a consistent format: personalized greeting, opening line, body paragraphs, closing sentence, and `Best regards,` with your full Gmail account name.
- **Detect Recipients and Sender**: Parses the **To** field and your signed-in Gmail display name so greetings use the recipient's first name and sign-offs use your full name.
- **Create or Regenerate Drafts**: **Create Draft** generates a new message; **Regenerate** replaces the compose body if you want a fresh take on the same instruction.
- **Generate Subject Lines (New Compose)**: On new emails, toggle subject generation on or off from the popover. When enabled, QuickMail writes a subject line and inserts it into the compose field; when disabled, your existing subject is preserved.
- **Configure Your API Key**: Open the QuickMail toolbar popup to save your OpenAI API key securely with `chrome.storage.sync`.

<p align="center">
  <img width="700" alt="QuickMail AI Button" src="public/QuickMail-WriteAIButton.png">
  <br>
  <b>Figure 2: Write with AI button injected next to Send in the Gmail compose toolbar.</b>
</p>

## Features

- **Gmail-Native Injection**: Content script detects compose windows via the Send button and message body, then injects the QuickMail button into Gmail's toolbar layout (including table-based `td.gU` rows).
- **MutationObserver Re-injection**: Debounced DOM observation keeps the button present when Gmail dynamically opens new compose windows or reply boxes.
- **Thread Context Extraction**: Collects subject from `h2.hP` and message text from `.a3s` elements, trimmed to 6,000 characters for the API payload.
- **Participant Parsing**: Reads recipient chips from the compose **To** field, resolves display names like `Jane Doe (jane@example.com)` to first names, and pulls the sender's full name from Gmail account metadata.
- **Compose Mode Awareness**: Distinguishes **new compose** from **reply** — subject generation and subject-line output apply only to new messages; replies return body text only.
- **Subject Toggle**: Icon control in the popover header toggles subject generation ON/OFF for new compose; defaults ON when the subject field is empty and OFF when you've already typed a subject.
- **Structured System Prompt**: GPT-4o is instructed to avoid AI-sounding filler, match thread tone, use contractions where natural, and never invent facts or commitments.
- **Fixed Popover Positioning**: Popover uses `position: fixed`, repositions on scroll/resize, and closes when the anchor button leaves the viewport.
- **Auto-Growing Textarea**: Instruction field expands as you type with no manual resize handle.
- **Secure API Key Handling**: Key stored in extension sync storage, never logged or written to the page DOM; user and model text inserted via `createTextNode` rather than `innerHTML`.
- **Minimal Permissions**: Requires `storage` plus host access to `mail.google.com` and `api.openai.com` only.
- **Branded UI**: Orange and green palette with the QuickMail logo across the Gmail button, popover, and settings popup.

<p align="center">
  <img width="800" alt="QuickMail Popover Prompt" src="public/QuickMail-PopoverPrompt.png">
  <br>
  <b>Figure 3: AI popover with instruction input, subject toggle, and Create Draft / Regenerate actions.</b>
</p>

## Technologies Used

- **Chrome Extension Manifest V3**: Modern extension architecture with a content script, action popup, and scoped host permissions.
- **Vanilla JavaScript**: No build step, framework, or backend — plain HTML, CSS, and JS loaded directly by the extension.
- **OpenAI Chat Completions API**: `gpt-4o` model for draft generation with a custom system prompt and compose metadata.
- **`chrome.storage.sync`**: Persists the user's API key across signed-in Chrome profiles.
- **DOM APIs**: `MutationObserver`, `ResizeObserver`, and compose-field `input` events for injection, layout, and Gmail integration.
- **Content Script + CSS**: `content.js` and `styles.css` injected on `https://mail.google.com/*` at `document_idle`.

<p align="center">
  <img width="700" alt="QuickMail Extension Popup" src="public/QuickMail-ExtensionPopup.png">
  <br>
  <b>Figure 4: Extension settings popup for saving your OpenAI API key.</b>
</p>

## How to Use

1. **Load the Extension in Chrome**:
   - Clone or download this repository:
     ```bash
     git clone https://github.com/KhalidHossainGitHub/QuickMail.git
     cd QuickMail
     ```
   - Open Chrome and go to **`chrome://extensions`**.
   - Enable **Developer mode** (top right).
   - Click **Load unpacked** and select the `QuickMail` folder.

2. **Add Your OpenAI API Key**:
   - Click the **QuickMail** icon in the Chrome toolbar.
   - Paste your [OpenAI API key](https://platform.openai.com/api-keys) and click **Save settings**.
   - Your key is stored locally in Chrome and sent only to `api.openai.com`.

3. **Draft an Email in Gmail**:
   - Open [Gmail](https://mail.google.com) and start a **new message** or **Reply**.
   - In the compose toolbar, click **Write with AI** (next to **Send**).
   - Type what you want the email to say in the instruction field.
   - For new compose, use the subject icon on the right to turn **Subject Generation** ON or OFF.
   - Click **Create Draft** to generate and insert the text into the compose body.
   - Click **Regenerate** if you want a new version from the same instruction.

4. **Review Before Sending**:
   - Always read and edit the draft before clicking **Send** — QuickMail assists with writing but you remain responsible for the final message.

<p align="center">
  <img width="700" alt="QuickMail Extension Page" src="public/QuickMail-ExtensionPage.png">
  <br>
  <b>Figure 5: Chrome Extensions page featuring QuickMail.</b>
</p>

## License

MIT
