# macOS signing & notarization

How to make the desktop app open on a Mac with a plain double-click: no
"damaged and can't be opened" dialog, no `xattr` workaround. The maintainer doing
this needs an Apple Developer Program membership. Signing also unlocks real macOS
auto-updates later: the updater is notify-only today *because* Squirrel.Mac
refuses to update unsigned apps.

Three ingredients, then one release:

| # | What | Where it comes from | Where it goes |
| --- | --- | --- | --- |
| 1 | Developer ID Application certificate (`.p12`) | Apple Developer portal + OpenSSL (any OS; a Mac is NOT required) | GitHub secret |
| 2 | App Store Connect API key (`.p8`) | App Store Connect (browser) | GitHub secret |
| 3 | Small config changes | this repo | `electron-builder.yml` + `release-desktop.yml` |

No Mac is needed at any point: the actual signing and notarization run on
GitHub's macOS runners using the secrets, CI verifies the result itself, and
the only Mac-flavored ritual left (creating the certificate) works with
OpenSSL on Windows. A real Mac only matters for the human double-click test at
the end.

---

## Step 1: Developer ID Application certificate (~10 min)

This is the identity that signs the app. **Developer ID Application** is the
exact type, not "Apple Development", not "Developer ID Installer". A
certificate is just a key pair plus Apple's blessing of the public half, and
OpenSSL mints key pairs on any OS, so this works on a Windows PC. Generate the private
key locally, never in a workflow: a key that has ever passed through CI logs
or artifacts is not private.

On Windows, in **Git Bash, not PowerShell** (OpenSSL ships with Git for
Windows but is not on PowerShell's PATH, and the `\` line continuations below
are Bash syntax). Work in a folder OUTSIDE any git repository: a private key
inside a working tree is one careless `git add` away from being committed.

1. Generate a private key and a certificate signing request:

   ```bash
   mkdir -p ~/apple-developer-id && cd ~/apple-developer-id
   openssl genrsa -out developerid.key 2048
   # MSYS2_ARG_CONV_EXCL stops Git Bash from mistaking the /CN=… subject
   # for a filesystem path and mangling it.
   MSYS2_ARG_CONV_EXCL='*' openssl req -new -key developerid.key \
     -out developerid.certSigningRequest \
     -subj "/emailAddress=YOUR_APPLE_ID_EMAIL/CN=Your Name/C=YOUR_COUNTRY_CODE"
   ```

2. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
   → **+** → under *Software*, pick **Developer ID Application** → upload
   `developerid.certSigningRequest` → **Download** the resulting
   `developerID_application.cer`.
3. Bundle Apple's certificate with the private key into a `.p12`:

   ```bash
   openssl x509 -inform DER -in developerID_application.cer -out developerid.pem
   # -legacy: macOS's keychain import (which CI uses) is picky about the
   # OpenSSL 3 default encryption; the password still protects the file.
   openssl pkcs12 -export -legacy -inkey developerid.key -in developerid.pem \
     -out certificate.p12
   ```

   Choose a strong export password. Keep `developerid.key` and
   `certificate.p12` somewhere safe; the certificate is valid for five years.
4. Turn the `.p12` into text for the GitHub secret:

   ```bash
   base64 -w0 certificate.p12 | clip
   ```

   The base64 string is now on the clipboard.

<details>
<summary>Doing this on a Mac instead</summary>

Keychain Access → **Certificate Assistant → Request a Certificate From a
Certificate Authority…** (email = Apple ID, saved to disk) replaces step 1;
double-click the downloaded `.cer`, then **My Certificates** → right-click →
**Export…** as `.p12` replaces step 3; `base64 -i certificate.p12 | pbcopy`
replaces step 4.

</details>

## Step 2: App Store Connect API key (~5 min)

This is what lets CI *notarize*: upload the signed app to Apple's malware
scan and staple the approval ticket, which is what silences Gatekeeper.

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) →
   **Users and Access** → **Integrations** → **App Store Connect API** →
   **Team Keys** → **Generate API Key**.
2. Name it e.g. `agent-observability-notarize`, role **Developer**.
3. **Download the `.p8` file. It is offered exactly once.** Store it with
   the `.p12`.
4. Note two values shown on that page: the key's **Key ID** and the page's
   **Issuer ID**.

## Step 3: GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**,
five of them:

| Secret name | Value |
| --- | --- |
| `MAC_CERT_P12` | the base64 string from step 1.5 |
| `MAC_CERT_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_P8` | the full text content of the `.p8` file (`cat AuthKey_XXXX.p8 \| pbcopy`) |
| `APPLE_API_KEY_ID` | the Key ID from step 2.4 |
| `APPLE_API_ISSUER` | the Issuer ID from step 2.4 |

## Step 4: repo changes

Two files. (A coding agent can also apply this section.)

### `src/desktop/agent-observability-desktop/electron-builder.yml`

Replace the `identity: null` block under `mac:` (and its "Builds are
unsigned" comment) with:

```yaml
  # Signed + notarized in CI (see docs/macos-signing-and-notarization.md).
  # Credentials arrive via env; a build without them stays ad-hoc signed and
  # skips notarization, so local packaging and forks keep working.
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true
```

No custom entitlements file is needed: electron-builder's defaults already
allow JIT and native modules (better-sqlite3), and it deep-signs every nested
binary with the same identity.

### `.github/workflows/release-desktop.yml`

Replace the single **Package installers** step with a per-platform pair, so
the mac certificate never leaks into the Windows leg (electron-builder would
try to sign the NSIS installer with it):

```yaml
      - name: Package installers (Windows)
        if: matrix.artifact == 'windows'
        working-directory: src/desktop/agent-observability-desktop
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: 'false'
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-builder --config electron-builder.yml --publish never

      - name: Package installers (macOS)
        if: matrix.artifact == 'macos'
        working-directory: src/desktop/agent-observability-desktop
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          MAC_CERT_P12: ${{ secrets.MAC_CERT_P12 }}
          MAC_CERT_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        run: |
          if [ -z "$MAC_CERT_P12" ] || [ -z "$APPLE_API_KEY_P8" ]; then
            # No credentials (fork, dry run): build unsigned, exactly as before.
            export CSC_IDENTITY_AUTO_DISCOVERY=false
            npx electron-builder --config electron-builder.yml --publish never \
              -c.mac.notarize=false
            exit 0
          fi

          keychain="$RUNNER_TEMP/signing.keychain-db"
          keychain_password="$(openssl rand -base64 24)"
          cert="$RUNNER_TEMP/certificate.p12"
          echo "$MAC_CERT_P12" | base64 --decode > "$cert"

          security create-keychain -p "$keychain_password" "$keychain"
          security set-keychain-settings "$keychain"
          security unlock-keychain -p "$keychain_password" "$keychain"
          security import "$cert" -k "$keychain" -P "$MAC_CERT_PASSWORD" \
            -T /usr/bin/codesign -T /usr/bin/productbuild
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
            -k "$keychain_password" "$keychain" > /dev/null
          security list-keychains -d user -s "$keychain" \
            $(security list-keychains -d user | tr -d '"')
          rm -f "$cert"

          # Notarization wants the .p8 as a file; the secret holds its text.
          echo "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/apple_api_key.p8"
          export APPLE_API_KEY="$RUNNER_TEMP/apple_api_key.p8"
          export CSC_KEYCHAIN="$keychain"
          npx electron-builder --config electron-builder.yml --publish never
```

The certificate is imported by the workflow rather than handed to
electron-builder as `CSC_LINK` on purpose. electron-builder's own keychain
import passes the `.p12` export password to `security set-key-partition-list
-k`, which expects the *keychain* password; macOS tolerated the mismatch until
the runner image reached Darwin 25.6, after which every signed build died with
`SecKeychainUnlock: The user name or passphrase you entered is not correct`.
Pointing electron-builder at a ready-made keychain with `CSC_KEYCHAIN` skips
that code path; identity discovery still finds the certificate there.

## Step 5: cut a release and verify (no Mac needed)

1. Tag and push a release as usual (`desktop-v<version>`); watch the mac leg.
   The log should show `signing` lines naming the Developer ID, then
   `notarization successful`. Notarization adds a few minutes (Apple's scan).
2. Let CI prove the result on its own macOS runner: add this step right
   after **Package installers (macOS)**:

   ```yaml
      - name: Verify signature and notarization (macOS)
        if: matrix.artifact == 'macos'
        working-directory: src/desktop/agent-observability-desktop
        run: |
          for app in release/mac*/*.app; do
            codesign --verify --deep --strict --verbose=2 "$app"
            xcrun stapler validate "$app"
          done
   ```

   A green step means both architectures are signed through and carry the
   stapled notarization ticket. Without a Mac, that is the whole proof.
3. The human check: have someone with a Mac download the arm64 DMG fresh from the
   release page, drag the app to Applications, and **double-click it**. It
   must open with no dialog: no right-click ritual, no `xattr`. (On a Mac,
   `spctl -a -vv "/Applications/Agent Observability.app"` should print
   `accepted, source=Notarized Developer ID`.)

## Afterwards

- **Turn on real macOS auto-updates.** `src/desktop/agent-observability-desktop/src/main/updater.ts`
  keeps macOS notify-only (it links to the release page instead of
  downloading) purely because the builds were unsigned. Once a signed release
  is live, that branch can use the same download-and-install flow as Windows.
  It is a small change to make once the first signed release is out.
- **Simplify the release notes.** The template in `release-desktop.yml` tells
  mac users to right-click → Open or run `xattr -cr …`; from the first signed
  release onward that paragraph can go.

## Troubleshooting

- **`Env WIN_CSC_LINK/CSC_LINK is not correct` or a keychain error on CI**:
  the base64 is truncated or the `.p12` password secret is wrong. Re-export
  and re-paste both. If the error is `SecKeychainItemImport` failing on the
  import itself, the `.p12` was exported without `-legacy`; re-run the
  `openssl pkcs12 -export -legacy …` command.
- **`errSecInternalComponent` / "unable to build chain to self-signed root"
  while signing**: the `.p12` carries only the leaf certificate and the
  runner lacks Apple's intermediate. Download **Developer ID - G2** from
  [apple.com/certificateauthority](https://www.apple.com/certificateauthority/),
  convert and include it:
  `openssl x509 -inform DER -in DeveloperIDG2CA.cer -out g2.pem`, then re-run
  the pkcs12 export with `-certfile g2.pem` added.
- **Notarization fails with an "invalid" status**: the log line includes a
  URL to Apple's JSON report naming the offending binary; almost always a
  nested unsigned binary, which `hardenedRuntime` + electron-builder's deep
  signing normally prevents.
- **`HTTP 401` during notarization**: Key ID / Issuer ID mismatch, or the
  `.p8` content lost its header/footer lines when pasted into the secret.
- **It still says "damaged" on someone's Mac**: they are opening an OLD
  download. Only releases built after this setup are notarized; earlier ones
  keep needing `xattr -cr`.
