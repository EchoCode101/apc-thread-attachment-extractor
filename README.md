# APC Extractor (NSFW)

A userscript that extracts all attachment links (images and archives) from threads on `forum.allporncomix.com` and exports them as download lists for JDownloader 2.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [How to Use](#how-to-use)
5. [Features in Detail](#features-in-detail)
6. [JDownloader Integration](#jdownloader-integration)
7. [The Back-Trace System](#the-back-trace-system)
8. [Limitations](#limitations)
9. [Future Improvements](#future-improvements)
10. [Frequently Asked Questions](#frequently-asked-questions)

---

## What It Does

This script runs **inside your browser** when you visit a thread on the APC forum. It finds every attached file in every post across every page, organizes them by album, and gives you:

- **A plain-text file** with all download links (`.txt`)
- **A JD2 crawljob file** (`.crawljob`) that JDownloader can import directly
- **A summary report** showing how many images and archives were found

### Real-world example

A thread has 40 pages with 500 images and 12 zip files spread across 5 posts. Instead of opening each post and clicking each link one by one, the script collects everything in seconds, groups files by their original post, and hands JDownloader a ready-to-go package list — each package named after the album, each link inside it, all pointing to the correct post.

---

## Prerequisites

### 1. A userscript manager — **Violentmonkey** (recommended)

The script needs a browser extension that can run custom JavaScript on web pages.

| Extension | Browser | Notes |
|-----------|---------|-------|
| **Violentmonkey** | Chrome, Firefox, Edge | Best performance, most reliable |
| Tampermonkey | Chrome, Firefox, Edge | Works but heavier |
| Greasemonkey | Firefox | Older, limited support |

> This script does **not** work with "Allow Copy" or "Copy as Markdown" extensions. It runs on the actual APC forum only.

**Install Violentmonkey:**
1. Go to the [Chrome Web Store](https://chrome.google.com/webstore/detail/violentmonkey/) (or your browser's add-on store)
2. Click **Add to Chrome** (or the equivalent for your browser)
3. Confirm the installation

### 2. **JDownloader 2** (optional but strongly recommended)

[JDownloader 2](https://jdownloader.org/) is a free download manager that can handle large file lists, resume broken downloads, and extract archives automatically.

You only need JDownloader if you plan to actually download the files. The script also works with plain text files for any other download manager.

---

## Installation

### Step 1: Install the script

1. Open the script file `APC Thread Attachment Extractor.js` in any text editor
2. Select **all** the text (Ctrl+A) and copy it (Ctrl+C)
3. Click the Violentmonkey icon in your browser toolbar -> **Create a new script**
4. Delete the default template text
5. **Paste** the copied script (Ctrl+V)
6. Press **Ctrl+S** to save
7. Close the editor tab

### Step 2: Visit the forum

Navigate to any thread on `forum.allporncomix.com/threads/*`. A dark floating panel appears in the top-right corner.

If you don't see the panel, refresh the page and make sure Violentmonkey is enabled.

---

## How to Use

### Quick start (extract everything)

1. Open a thread
2. Click **Extract Entire Thread**
3. Wait for the scan to finish
4. Files are automatically downloaded:
   - `{thread_name}_all_attachments.txt` — all links
   - `{thread_name}.crawljob` — JDownloader import file
   - `{thread_name}_summary.txt` — report

### Selecting a page range

- **Start**: the first page you want to scan (default: 1)
- **End**: leave blank to scan all pages, or enter a specific page number

The script will only scan pages within the range you set.

### Filtering by file type

| Checkbox | Effect |
|----------|--------|
| **Images Only** | Only extracts image files (.jpg, .jpeg, .png, .gif, .webp) |
| **Archives Only** | Only extracts archive files (.zip, .rar, .7z) |

The two checkboxes are mutually exclusive — checking one unchecks the other.

### During extraction

While scanning, the panel shows a progress bar, current page info, estimated time remaining, and live counts of albums/images/archives found. You can **Pause** or **Cancel** the extraction at any time. Use the **`−`** button in the header to collapse the panel and keep the thread content visible.

### The Settings panel (gear icon)

Click the gear icon next to the title to open settings. From here you can configure:

| Setting | What it does | Default |
|---------|-------------|---------|
| **Download Folder** | Base folder where files are saved (JDownloader) | `E:\Downloads\APC` |
| **Chunks** | Number of simultaneous connections per file | 1 |
| **Priority** | Download priority in JDownloader | DEFAULT |
| **Create Subfolder per Package** | Each album gets its own subfolder | ON |
| **Deep Analyse** | Let JDownloader scan inside archives | ON |
| **Auto Start** | Start download immediately in JDownloader | OFF |
| **Auto Confirm** | Skip confirmation dialogs in JDownloader | OFF |
| **Delay Min/Max** | Random wait between page requests (milliseconds) | 200-650 ms |
| **Max Retries** | Number of times to retry a failed page | 3 |
| **Export .txt** | Create a plain-text link file | ON |
| **Export .crawljob** | Create a JDownloader import file | ON |
| **Copy to Clipboard** | Copy all links to clipboard automatically | ON |
| **Deduplicate Links** | Remove duplicate links within a package | ON |
| **Merge Packages** | Combine same-named packages across pages | ON |

Click **Reset Defaults** to restore factory settings, **Cancel** to discard changes, or **Save** to keep them.

---

## Features in Detail

### Intelligent package naming

The script tries several strategies to name each album package, in this order:

1. **Bold text before any heading** — if the post starts with a title in `<b>` tags, that becomes the package name
2. **First bold text** — the first `<b>` or `<strong>` element
3. **First meaningful text** — the first line of actual content
4. **Fallback** — `Unknown Album [#postId]`

Each package name is appended with `[#123456]` where `123456` is the forum post ID. This guarantees every package has a unique, traceable name.

### Resume support

If the extraction is interrupted (browser crash, tab closed, etc.), the script saves its progress to your browser's local storage. When you click **Extract** again, it asks whether to continue from where you left off or start fresh.

### Duplicate link removal

Links that appear in multiple posts (e.g., the same file quoted in a reply) are deduplicated, so you never download the same file twice.

### Collapsible panel

The extraction panel can be collapsed to keep the thread content visible. Click the **`−`** button in the panel header to collapse it, and **`+`** to expand it again. The collapse state is saved to your browser's local storage, so the panel stays collapsed across page reloads.

The collapse animation uses a CSS `max-height` + `opacity` transition for a smooth, lightweight effect with no JavaScript animation library required.

---

## JDownloader Integration

### Method 1: Add Link Container (easiest)

1. Open JDownloader 2
2. Go to the **LinkGrabber** tab
3. Click the menu button (three dots or hamburger icon)
4. Select **Add Link Container**
5. Browse to the `.crawljob` file that was downloaded and select it
6. JDownloader imports all packages with their correct names, folders, and settings
7. Click **Continue** to start downloading

### Method 2: Folder Watch (automatic, recommended for frequent use)

The Folder Watch feature monitors a folder on your computer. Any `.crawljob` file placed there is automatically imported.

**To enable Folder Watch:**

1. In JDownloader 2, go to **Settings** -> **Advanced Settings**
2. Search for `FolderWatch`
3. Enable **FolderWatchController.enabled**
4. Set **FolderWatchController.watchFolder** to a folder of your choice (e.g., `E:\Downloads\APC\CrawlJobs`)
5. Now every extraction automatically places a `.crawljob` file in that folder, and JDownloader picks it up instantly

### What a crawljob contains

Each `.crawljob` file stores the package name, download destination folder, priority, connection count, a comment with the original thread/post URL, and all download links.

---

## The Back-Trace System

Every downloaded file can be traced back to its exact source post, even years later.

### How it works

1. **Package name contains the post ID**: `3D Artwork Collection 02 [#262916]`
2. **The post URL is stored in the crawljob comment**: `Post: https://forum.allporncomix.com/.../post-262916`
3. **The download folder includes the post ID**: `E:\Downloads\APC\3D Artwork Collection 02 [#262916]`

### Why this matters

If you ever need to find the original post again:

- **JDownloader history available**: Open the package info, read the comment for the direct post URL
- **JDownloader history cleared**: The folder name still contains `[#262916]`. Searching `262916` on the APC forum takes you directly to the post
- **Files moved to another drive**: The `_summary.txt` file you saved lists every post with its URL
- **Browser bookmarks lost**: The URL pattern is predictable — `https://forum.allporncomix.com/threads/{thread-slug}.{thread-id}/post-{post-id}`

This design means you never permanently lose track of where a file came from.

---

## Limitations

| Limitation | Explanation |
|-----------|-------------|
| **APC forum only** | The script is hardcoded to `forum.allporncomix.com`. It will not work on other forums |
| **Requires browser** | The script runs as a userscript inside your browser. You must have the forum page open |
| **No login handling** | You must be logged into APC in your browser. The script uses your existing session |
| **Single-thread extraction** | Each run processes one thread. You cannot queue multiple threads |
| **No progress between sessions** | If you close the browser, resume works but the progress bar is lost |
| **JDownloader comment not in Windows file properties** | The trace-back comment is stored in JDownloader only, not in Windows file metadata |
| **Subfolder creation is a workaround** | The script sets a per-package download folder path instead of relying on a JDownloader setting |

---

## Future Improvements

- **Multi-thread queue** — Add support for extracting links from multiple threads in sequence
- **Direct download** — Option to download files directly through the browser instead of using JDownloader
- **Search by tag/author** — Extract links from all threads by a specific author or with a specific tag
- **Command-line mode** — A Node.js version that does not need a browser
- **Dark mode toggle** — For lighter panels on light-themed pages
- **Export formats** — Support for `.dlc` (JDownloader container) and other formats

---

## Frequently Asked Questions

### The panel doesn't appear

1. Make sure you are on `https://forum.allporncomix.com/threads/*`
2. Check that Violentmonkey is enabled and the script is active
3. Refresh the page
4. Try disabling other userscripts that might conflict

### Links are empty or show 0 results

- The thread might have no attachments
- Check that you have not checked both **Images Only** and **Archives Only** (they are mutually exclusive)
- Try running without any filter first

### The script missed some files

- Some posts may use non-standard attachment containers. The script looks for `<section class="message-attachments">` and inline `<a>` tags with `/attachments/` in the URL
- If a file is linked in a custom way (e.g., a direct URL to an external host), it will not be detected
- For missing attachments, please report the specific thread URL so the pattern can be updated

### Can I use this with another download manager?

Yes. The `.txt` file contains plain URLs, one per line. Any download manager that supports importing a list of URLs (Internet Download Manager, Free Download Manager, aria2, wget) can use it.

### Does the script download anything itself?

No. The script only runs inside your browser to scan the page and extract links. It does not download files, send data to external servers, or modify the forum in any way. All it does is produce `.txt`, `.crawljob`, and `.txt` summary files that you save to your computer.

### Why does the script need `GM_setClipboard` permission?

The script automatically copies all extracted links to your clipboard so you can paste them into any download manager immediately. This permission is listed in the `@grant` section at the top of the script.

### Will this work on mobile browsers?

No. Violentmonkey exists for Firefox for Android, but the script's UI is designed for desktop screen sizes. Mobile support is not planned.

### How do I update the script?

1. Open the Violentmonkey dashboard
2. Find "APC Thread Attachment Extractor" in the list
3. Click the **Edit** button
4. Copy the new version from the `.js` file and paste it over the old code
5. Press **Ctrl+S** to save

### What if a post has no title?

The script falls back to `Unknown Album [#postId]`, where `postId` is the numeric ID of the post. This always gives you a way to find the original post by searching the ID on the forum.

### Can I run this on a private/offline copy of the page?

No. The script relies on fetching pages from the live forum using your login session. It cannot process local HTML files.

---

## License

Free for personal use.
