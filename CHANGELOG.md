# Changelog

## 0.9.0

### 🎁 New
- Memory — Pipali now remembers things across conversations, so it will tune itself to your preferences, use-cases and environment over time. Review, delete, or turn memories entirely off from Settings → Permissions.

### 🧪 Improve
- Built-in skills now stay up to date with new app releases (your own edits are kept)
- Shorter, more readable file paths shown on Windows

### 🛠️ Fix
- Fix blank app window on newer Linux distros (Arch, Fedora, Debian 13)
- Fix sign-in and browser links not opening from the Linux app on some desktops
- Access Pipali over Tailscale or a reverse proxy again (start app with `PIPALI_TRUSTED_HOSTS` env var set to server name)
- Chats sync after app reconnects (e.g. when your Pipali phone progressive web app wakes from sleep)

## 0.8.0

### 🎁 New
- Voice mode — Assign tasks and provide guidance with voice, so your hands, eyes stay free. Use earbuds to step away from your desk (go cook, read, caffeinate). In Ask first mode, Pipali will chime and wait when it needs your attention. Enable voice mode via Settings/Permissions.
- Background tasks - Pipali can now delegate tasks to background chats or terminals. So it stays available to chat while they work. Parallelize research or manage multiple coding sessions (e.g. claude, codex) from a single Pipali chat.

### 🧪 Improve
- Improve UX: Sidebar collapses to an icon rail, chat text can be resized and messages and images get more space

### 🛠️ Fix
- MCP tool servers will automatically reconnect on temporary connection issues

## 0.7.0

### 🎁 New
- Search inside PDFs, Word, Excel, PowerPoint, and OpenDocument files
- Connect Google Workspace MCP servers with OAuth

### 🧪 Improve
- Smarter MCP tool loading to keep responses fast with many servers connected
- Full markdown rendering in the reasoning trajectory
- App opens automatically after login in the browser

### 🛠️ Fix
- Inline math equations now render correctly from more AI models

## 0.6.0

### 🎁 New
- Use Ollama, OpenRouter and other OpenAI Responses compatible API by setting OPENAI_BASE_URL
- Connect OAuth-secured MCP servers like Slack, Google Workspace and Notion from the Tools page

### 🧪 Improve
- Stream chat responses for a faster, readable chat UX
- Error responses shown as dismissible cards with copyable details instead of raw text

### 🛠️ Fix
- Make Pipali app work on Ubuntu, Debian again
- Multiple, same turn edits to the same file no longer overwrite each other

## 0.5.2

### 🧪 Improve
- App loads faster and uses much less space
- Pause or resume a routine directly from its card on the Routines page
- Enable or disable an MCP server directly from its card on the Tools page
- Refreshed tool card layout with clearer titles, status, and color-coded risk on the Tools page
- Sharper trajectory preview that highlights the latest step's messages and tool calls
- GPT models share progress updates more consistently during long-running jobs

### 🛠️ Fix
- Shell commands no longer break on literal `$` characters

## 0.5.1

### 🎁 New
- Model selector now shows tier, tagline, and cost tier to help you choose the right model
- Clear finished tasks from home page in one click with new bulk dismiss action
- Attach files when answering confirmation questions and Pipali will receive them

### 🧪 Improve
- Home page no longer shows tasks you've already seen finish, only unseen completed tasks appear
- Visually distinguish queued messages when sent mid-run
- Pipali can fetch fresh webpage content for time-sensitive pages like news, prices, or status updates

### 🛠️ Fix
- Model shown in model selector always stays in sync when switch conversations

## 0.5.0

### 🎁 New
- Use the app in French, German, Japanese, or Simplified Chinese
- Schedule an automation on multiple days of the week

### 🧪 Improve
- Resize app icon to follow Apple styling guidelines on macOS
- Reveal app window when clicking the dock icon while hidden to tray
- Allow expanding tool call details before result arrives in trajectory outline view
- Make GPT models emit user-friendly progress updates while working
- Handle very long webpages consistently without truncating too early
- Continue or dismiss directly from the inline add-credit dialog in chat
- Show clear, actionable error when your access expires during a chat

### 🛠️ Fix
- Consistently scroll to last message and avoid sporadic blank screen when open conversation
- Fix shell tool escaping to run more inline scripts written by Pipali
- Fix duplicate rendering of shell command output on interrupt
- Fix duplicate rendering of math equations

## 0.4.0

### 🎁 New
- Copy link, messages, or raw trace of any chat from the sidebar menu
- Toggle which skills are visible to Pipali from the skills page

### 🧪 Improve
- Click Pipali OS notification to open the app to that conversation on Windows and Mac
- Show app version and what's new in app from user profile menu in sidebar

### 🛠️ Fix
- Enable Pipali to use Chrome browser on more machine setups
- Fix shell sandbox to allow reads from the temp directory

## 0.3.0

### 🎁 New
- Empower Pipali to help you onboard, navigate it and re-configure itself
  You can now just ask Pipali to find/refer to old chats, create routines and connect to mcp tools
- Pin conversations to home page for easy, quick access
- Stream task and automation runs in real-time across multiple devices

### 🧪 Improve
- Improve the routines page UX with sticky controls, better icons and concise schedules
- Add ability to jump through user/ai chat messages using new message navigator
- Reduce OS permission triggers on Mac by not touching sensitive directories
- Show full intermediate responses and cycle detail level of each item in train of thought

### 🛠️ Fix
- Show cause of failure to connect to MCP server on tools page
- Update user name in sidebar if changed in Google or settings page

## 0.2.3

### 🎁 New
- Search across all your chat messages from the chat switcher
- Set custom titles on conversations to make them easy to find

### 🧪 Improve
- Keep Device Awake preference now persists across app restarts
- Make task runs more robust by retrying on unexpected response
- Improve rendering of nested lists in messages

### 🛠️ Fix
- Auto scroll train of thought when near bottom and expanded
- Show guidance with confirmations instead of sending a new message

## 0.2.2

### 🎁 New
- Sign Windows desktop app so no more SmartScreen warnings on install

### 🧪 Improve
- Use platform recommended chat model by default until you pick one

### 🛠️ Fix
- Fix Linux AppImage builds

## 0.2.1

### 🧪 Improve
- Make confirmation dialogs and toasts more compact and readable
- Show Chrome browser usage steps in train of thought for easier understanding
- Simplify MCP server confirmation mode descriptions

### 🛠️ Fix
- Show actionable error page when something goes wrong in the app
- Fix compatibility with older Safari versions

## 0.2.0

### 🎁 New
- Attach files to chat via drag-and-drop, copy-paste or the attach button

### 🧪 Improve
- Three detail levels (outline, summary, detail) in train of thought dropdown
- Show tool count per category on home page task cards
- Make task overview on chat page more visually informative
- Improve image generation and file tool rendering in train of thought
- More personal home greeting with tips in chat input placeholder
- Add playful animation to empty state that reacts to your input

### 🛠️ Fix
- Prevent database corruption from partial migration failures
- Allow opening web links from train of thought on desktop app

## 0.1.1

### 🎁 New
- Use Pipali on Linux
- Interact with Claude models, like Opus, via the platform
- Ask Pipali to email you, especially useful with Routines (e.g. get a weekly report in your inbox)

### 🧪 Improve
- Better handling of dates near midnight for more accurate scheduling
- Fallback to default model if a previously used model is deleted

### 🛠️ Fix
- Fix opening links from chat on the desktop app

## 0.1.0

The first release of Pipali!

### 🏔️ Work Async
- Assign Pipali tasks and go grab a coffee. Track progress, give feedback and get notified when it needs your attention

### 📑 Create Polished Deliverables
- Turn messy inputs into shareable outputs — briefs, decision memos, project updates, meeting notes and spreadsheets

### ⏱️ Automate Routine Work
- Set up tasks on a schedule or trigger them manually. "Draft my weekly project update email", "Sync my ledger on the 1st of every month"

### 🎓 Teach It Your Workflows
- Create skills for all your custom workflows — where to find project documents, which accounting method to follow or your email organization policy

### 🛠️ Connect Your Tools
- Integrate Jira, Linear, Slack and more via MCP. Pipali can create issues, post messages and interact with external APIs on your behalf
- Use the right AI model for the right task. Model access provided through the Pipali Platform — Single Sign On, no API key setup needed

### 🦺 Run Safely
- Commands run in a local sandbox that restricts file and network access. Commands needing broader access require your explicit approval
- Desktop app for Mac and Windows with system tray
