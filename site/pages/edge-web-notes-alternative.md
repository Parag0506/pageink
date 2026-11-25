# What to use in Edge now that Web Notes is gone

Web Notes was a feature of the old Microsoft Edge that let you mark up web pages. [Microsoft's support page](https://support.microsoft.com/en-us/microsoft-edge/find-your-reading-list-web-notes-and-tabs-in-microsoft-edge-3a3c21c2-7e25-9cc1-95f4-9df1f2ad55e5) says the new Edge no longer supports Web notes.

PageInk is a free extension for Edge that does a similar job. You write or draw on the live page with a mouse, a pen or a finger, and your notes come back on the same words when you open the page again. PageInk is not made by Microsoft.

## How do I start writing on a page in Edge?

- Add [PageInk from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/pageink/nocfjhikfelnnjakadlpchhppdihamdo). PageInk supports Edge 119 or later.
- Open any web page.
- Click the PageInk button in the toolbar, then click **Draw on this page**. The button then reads **Drawing on**. The suggested keyboard shortcut is Alt+Shift+D.
- Write or draw with the mouse or the trackpad. A bar with the tools shows on the page.
- Press Esc to stop drawing.
- Close the tab and open the same page later. Your notes are back on the same words.

For a quick mark, hold Alt and drag with the mouse. You do not need to turn on Draw. In the settings you can change Alt to Control or Meta, or turn this off.

With a pen on a touch screen, touch the page and write. No switch is needed. Pens on Windows have been tested only with simulated input so far.

## Where are my old Web Notes?

The same Microsoft page says that web notes you saved, in Favorites or in OneNote, are still in the same places. PageInk cannot open or import them.

## What can I do with it?

- Write in two pen colours, highlight, erase, undo and redo.
- Use the lasso to move, split or join notes.
- Draw a straight line over text to underline or highlight it. The mark is redrawn on the same words when the window is resized.
- Use the **More** menu on the bar to **Save as image**, **Save notes as Markdown**, **Copy for chat** or **Print**.
- See every page you wrote on in the **Library** tab of the settings page.

## What it cannot do

- It does not share notes with other people. You can export them and send the file.
- It does not turn handwriting into typed text.
- Input that a web page script makes up is ignored. Only real mouse, touch and pen input draws.
- If a page changes so much that the words are gone, the note waits in the **Moved notes** tray on that page, and you place it again by hand. In the project's tests, a few notes landed on a similar passage instead. [Why notes stay on the page after a reload](/notes-stay-after-reload/) has the numbers.
- **Clear page** in the **More** menu removes all ink on the page after you confirm. It cannot be undone.

## Where are my notes kept?

In Edge's storage for the extension, on your device. There is no PageInk account and no PageInk server. Your notes do not go to Microsoft or anyone else unless you connect your own cloud, and then they go only to that cloud. The one other request reads a PDF you opened once more from its own address, for PageInk's PDF viewer.

Removing the extension removes the notes on that device, so keep a copy if they matter. In the settings, choose **A folder on this device**, or use **Export archive** in the **Library** tab. OneDrive and Google Drive can be connected too. So far the project has tested those two against local stand-ins for the services, and some points still need a check with the real ones. The [privacy policy](/privacy/) has the full list.

## Common problems

**The mouse scrolls the page and does not draw.** Draw is off. Click the PageInk button and check that it reads **Drawing on**.

**A finger scrolls instead of writing.** That is by design. A finger scrolls until you turn on Draw. With Draw on, one finger writes and two fingers scroll.

**My notes are missing from a page.** Open the **Moved notes** tray on the bar. Ink written in a private window is not saved unless you turn on **Keep ink written in private windows** in the settings.
