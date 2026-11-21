# Setting up Google Drive and OneDrive

The extension signs readers in to their own Google Drive or OneDrive. There is no server of ours.
For that, Google and Microsoft each need to know the app: you register it once and get a
**client id**. A client id is not a secret. It is built into the extension, like a name tag.
There is no client secret anywhere; do not create or paste one.

Until an id is set, that button in the extension is shown greyed out with "Not set up in this
build." Everything else works without it.

You need: a Google account, a Microsoft account, and about 40 minutes.

## The least you need to try it yourself

To test with your own account only, in Chrome and in the app on your Mac or iPad:

1. Make the key for a fixed extension id (section 1, steps 1 to 4). Write down the return address.
2. Google: make a project, turn on the Drive API, set up the consent screen as **External**, add
   your own address as a test user, and make two clients in that project: a **Web application**
   client with the return address, and an **iOS** client with the app's bundle id (section 2 and
   "The Apple app" below). Skip the publishing steps.
3. Microsoft: make one app registration for personal and work accounts. Add the return address
   under **Single-page application**, and `msauth.<bundle id>://auth` under **Mobile and desktop
   applications** (section 3 and "The Apple app").
4. Paste the ids into the two local files: `packages/extension/cloud-ids.local.json` (web
   client) and `apple/Shared/cloud-ids.local.json` (iOS client). Git ignores both.
5. Build, then choose **Google Drive** or **OneDrive** in the extension's settings or in the
   app's **Sync** screen. Your notes go to the same files from both.

Google lets only your test users sign in, and asks again every 7 days. That is fine for a test.

## 1. A fixed extension id

Each sign-in comes back to an address made from the extension's id. An unpacked extension gets a
new id on every machine unless the manifest carries a key. Make one key pair, once:

1. In a terminal, at the top of the repository, run:
   `node packages/extension/scripts/dev-key.mjs`
2. It writes two files in `packages/extension/`:
   - `dev-key.pem`: the private key. Git ignores it. Keep it safe and never share it.
   - `dev-key.pub`: the public key. You may commit it.
3. It prints the extension id and the return address, for example
   `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/`. Write the address down.
4. Build with the key: `INK_DEV_KEY=1 corepack pnpm --filter pageink-extension build`.
   Release builds and store packages never carry the key: the stores give the extension its id.

### The return addresses

You register these with Google and with Microsoft. One per browser:

| Browser             | Return address                              | Where the id comes from               |
| ------------------- | ------------------------------------------- | ------------------------------------- |
| Chrome, development | `https://<id from step 1>.chromiumapp.org/` | `dev-key.pub`                         |
| Chrome, store       | `https://<store id>.chromiumapp.org/`       | the Chrome Web Store page of the item |
| Edge, store         | `https://<Edge store id>.chromiumapp.org/`  | the Edge Add-ons page of the item     |
| Firefox             | `https://<code>.extensions.allizom.org/`    | see below                             |

For Firefox, the code comes from the add-on id (`FIREFOX_ID` in
`packages/extension/src/brand.ts`; set a permanent one first). To read it: open
`about:debugging`, load the add-on, choose **Inspect**, and type
`browser.identity.getRedirectURL()` in the console.

The trailing `/` matters. Register each address exactly as shown.

You do not have to work the address out by hand. The extension's settings show it on the
Connect screen, under the cloud choices: "Return address used by this build" (on Chrome and
Edge, choose **Show the return address to register** first; it asks the browser, which makes
the address from the extension id). After a failed sign-in it is also in the **Details**
block, with a **Copy details** button. Compare it with what you registered, character by
character.

## 2. Google Drive

1. Go to https://console.cloud.google.com and sign in.
2. At the top, open the project list and choose **New project**. Give it the product's name.
   Choose **Create**, then make sure the new project is selected.
3. Turn on the Drive API: in the search bar type **Google Drive API**, open it, choose **Enable**.
4. Open **Google Auth Platform** (search "OAuth consent screen" if you do not see it).
   Choose **Get started**.
   - App name: the product's name. User support email: your address.
   - Audience: **External**.
   - Contact email: your address. Accept the policy and choose **Create**.
5. Still in Google Auth Platform, open **Data access** and choose **Add or remove scopes**.
   Tick only `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive
   files you use with this app"). Choose **Update**, then **Save**. Do not add `email`,
   `profile` or `openid`: neither the extension nor the Safari app asks for them.
6. Open **Audience**. Under **Test users** choose **Add users** and add the Google accounts that
   will try it (yours first). Only these can sign in while the app is in testing.
7. Open **Clients** and choose **Create client**.
   - Application type: **Web application**. Name: anything.
   - Under **Authorized redirect URIs** (not **Authorized JavaScript origins**) choose
     **Add URI** and paste each return address from step 1, one per line. It must match
     exactly: `https`, lower case, and the trailing `/`. Leave JavaScript origins empty.
   - Choose **Create**. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
     Ignore the client secret.
   - Google says a change here can take from a few minutes to a few hours to apply. If the
     sign-in window shows **Error 400: redirect_uri_mismatch** right after you added the
     address, wait and try again before changing anything.

## 3. OneDrive (Microsoft Entra)

1. Go to https://entra.microsoft.com (or https://portal.azure.com and search "App registrations").
2. Open **Applications**, then **App registrations**, then **New registration**.
   - Name: the product's name.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft
     accounts**.
   - Redirect URI: leave it empty for now. Choose **Register**.
3. On the new app's page, copy the **Application (client) ID**.
4. Open **Authentication**, choose **Add a platform**, then **Single-page application**. Add
   each return address from step 1. Choose **Configure**. Do not tick the implicit grant boxes.
   - Use **Single-page application**, not **Mobile and desktop applications**. The extension
     asks for its token from the browser, and the browser always adds an `Origin` header that
     the extension cannot remove. Microsoft answers such a request only for a single-page
     application address; for a "Mobile and desktop" address it refuses with `AADSTS9002326`.
   - A single-page application sign-in renews itself every 24 hours without a window, as long
     as the reader stays signed in to Microsoft in that browser.
   - If you already added the addresses under **Mobile and desktop applications**, remove them
     there first.
5. Open **API permissions**, choose **Add a permission**, then **Microsoft Graph**, then
   **Delegated permissions**. Tick only `Files.ReadWrite.AppFolder` and `offline_access`.
   Choose **Add permissions**. No admin consent is needed. If `openid`, `profile` or
   `User.Read` are listed (new registrations add `User.Read` by itself), remove them: neither
   the extension nor the Safari app asks for them, and without them the consent screen lists the
   least. The extension and the app then say "Connected to OneDrive" without an account name.

The extension's files then live in the reader's OneDrive under **Apps**, in a folder with the
app's name. The extension cannot see anything else in their OneDrive.

## 4. Where to paste the ids

Make the file `packages/extension/cloud-ids.local.json` (git ignores it):

```json
{ "google": "1234-abc.apps.googleusercontent.com", "microsoft": "00000000-0000-0000-0000-000000000000" }
```

The committed `packages/extension/cloud-ids.json` keeps empty ids until a release commits its ids
there. Build again.

To try it: build with `INK_DEV_KEY=1`, load `packages/extension/.output/chrome-mv3` as an unpacked
extension, open its settings, and choose **Google Drive** or **OneDrive**.

## 5. The Apple app (Safari on Mac and iPad)

Safari cannot open a sign-in window for an extension, so the app signs in itself, with the
system sign-in window, and keeps the tokens in the keychain. It needs its own entries with
Google and Microsoft, in the **same** project and registration as above.

You need the app's bundle id: `INK_BUNDLE_ID_BASE` in `apple/Config/Local.xcconfig` (or in
`apple/Config/PageInk.xcconfig` when you have no local file). Below it is written `<bundle id>`.

### Google: an iOS client in the same project

1. In the **same** Google Cloud project as the Web client of section 2, open **Clients** and
   choose **Create client**.
2. Application type: **iOS**. This is right for the Mac too: Google says "For iOS and macOS
   apps the OAuth client ID application type must be configured as iOS".
3. Bundle ID: `<bundle id>`. Leave the App Store id and the team id empty if you do not have
   them. Choose **Create** and copy the **Client ID**. An iOS client has no secret.

Why the same project matters: with `drive.file`, an app sees only the files that this project's
clients made. A client in another project would not see the notes the extension wrote, and the
extension would not see the app's. Google counts every client in one project as the same app.

The app returns from Google to `com.googleusercontent.apps.<the start of the client id>:/oauthredirect`.
You do not need to type it anywhere: Google knows it from the client.

### Microsoft: one more redirect on the same registration

1. Open the app registration of section 3, then **Authentication**, then **Add a platform**.
2. Choose **Mobile and desktop applications** and add `msauth.<bundle id>://auth` under
   **Custom redirect URIs**. Choose **Configure**. (Microsoft's own guide sends apps that do the
   sign-in themselves, without its library, to this platform. The **iOS / macOS** platform makes
   the same address from the bundle id, so that works too.)
3. Keep the same API permissions. The Application (client) id is the same as the extension's.

### Where the ids go for the app

Make `apple/Shared/cloud-ids.local.json` (git ignores it):

```json
{ "google": "1234-ios.apps.googleusercontent.com", "microsoft": "00000000-0000-0000-0000-000000000000" }
```

The committed `apple/Shared/cloud-ids.json` keeps empty ids. Build the app again. With an empty
id, that choice in the app's **Sync** screen shows "Not set up in this build."

## 6. Before a public release on Google

While the app is in **Testing** on Google:

- Only the test users you added can sign in, at most 100 of them.
- Each sign-in lasts at most 7 days. After that the extension says "Your sign-in to Google Drive
  has expired" and the reader signs in again with one click.
- Google shows a "Google hasn't verified this app" screen. Testers choose **Continue**.

To open it to everyone, in **Audience** choose **Publish app**. For that Google asks for:

- a home page and a privacy policy on a domain you own (the repository's `PRIVACY.md`, published
  on that site, is the policy),
- that domain verified in Google Search Console and listed under **Branding**, **Authorized
  domains**,
- the app name and logo checked by Google (brand verification). `drive.file` is not a sensitive
  scope, so no security review is needed for it.

Microsoft has no such step for these permissions. You may add a publisher domain under
**Branding & properties** so the consent screen shows a verified publisher.

## 7. The provider's permission screen

Google and Microsoft show their own screen before the first sign-in. The Connect screen
explains it beforehand with these words, which also stand in PRIVACY.md:

> Next you will see a screen from Google or Microsoft. It says PageInk can use files in its own
> folder. PageInk there means this extension on your device. Your notes go straight from your
> device to your own Drive or OneDrive. We have no servers and receive nothing.
> It cannot see anything else in your Drive or OneDrive.

The scopes make that true: Google gets only `drive.file`, and Microsoft only
`Files.ReadWrite.AppFolder` and `offline_access`. A unit test fails if any other scope is ever
asked for.

## 8. When a sign-in fails

The Connect screen says which of two things happened:

- "You closed the sign-in window or chose Cancel." An error page at the provider, such as
  Google's `redirect_uri_mismatch`, also ends this way, because the window never comes back.
  Compare the return address shown below the message with what you registered.
- "Sign-in worked, but Google Drive (or OneDrive) refused the next step." Open **Details**: it
  shows the step (authorize, token, refresh, first file call), the provider's error code, its
  description with ids and addresses removed, the HTTP status, and the return address. Known
  codes get one sentence on what to change. **Copy details** puts all of it on the clipboard.
  Tokens, codes and the code verifier are never in it.

## 9. What to expect on each browser

| Browser             | What happens                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chrome              | The reader clicks a cloud; the browser grants the sign-in window without a prompt; Google's or Microsoft's page opens in a small window.                                       |
| Edge                | The same, with Edge's own id in the return address. Edge has no "Sign in with Chrome", which is not used.                                                                      |
| Firefox (computer)  | The same. `identity` is listed in the manifest because Firefox does not allow it as optional. It shows no warning.                                                             |
| Firefox for Android | No sign-in window exists there. Only the archive is offered.                                                                                                                   |
| Safari (Mac, iPad)  | The two cloud buttons ask the app, which signs in itself (NATIVE_PROTOCOL.md). On the Mac the app opens by itself; on the iPad the reader taps **Open** once. Needs section 5. |

## What still needs checking with real ids

The code follows the providers' documents. These points could only be tested against the local
fakes, and each sits behind one small function with a comment that says what to check:

- [ ] Google accepts the token flow (`response_type=token`) from `launchWebAuthFlow` with a Web
      client and the `chromiumapp.org` address (`googleAuthUrl` in `src/cloud/google.ts`).
- [ ] Silent renewal with `prompt=none` returns a new Google token in the background while the
      reader is signed in to Google in that browser.
- [ ] `about.get` answers with `drive.file`, to show the account address (`signIn` in google.ts).
- [ ] Drive's `modifiedTime` search also returns files moved to the bin (the change check).
- [ ] Microsoft: the "Single-page application" address works from `launchWebAuthFlow` and the
      service worker's `fetch` (`tokenRequest` in `src/cloud/onedrive.ts`), and the silent
      sign-in after 24 hours gets a new refresh token. Firefox should send an `Origin` header
      too; if it gets `AADSTS9002327`, register the Firefox address under "Mobile and desktop
      applications" instead.
- [ ] Graph delta works on the `pages` folder for personal and for work accounts (`latest` in
      onedrive.ts; without it, each sync lists the folder).
- [ ] The hosts Graph redirects downloads to are covered by `connect-src` (`download` in
      onedrive.ts; the list is `CLOUD_CONNECT` in `build/targets.ts`).
- [ ] Edge: `launchWebAuthFlow` with the `chromiumapp.org` address.
- [ ] Firefox: the `allizom.org` address is accepted by both providers, and the background page's
      `connect-src` lets the requests through.

For the Apple app (`Redirects.of` in `apple/Shared/CloudAuth.swift` holds the comment):

- [ ] Google accepts `com.googleusercontent.apps.<id>:/oauthredirect` from an iOS client, on the
      iPad and on the Mac, and the token address answers without a secret.
- [ ] Google sends a refresh token without `access_type=offline`, so the app and Safari keep
      syncing after the first hour.
- [ ] A file the extension made through the Web client is listed by the app through the iOS
      client, and the other way round (same project).
- [ ] Microsoft accepts `msauth.<bundle id>://auth` under "Mobile and desktop applications",
      for a personal and a work account.
- [ ] On the iPad, the extension's **Open** button brings the app to the front, and the app
      starts the sign-in.
- [ ] The extension's process can read the tokens from the shared keychain group on a signed
      build (App Group as the access group).
- [ ] OneDrive's download hosts answer the app (`download` in `apple/Shared/CloudProviders.swift`).
