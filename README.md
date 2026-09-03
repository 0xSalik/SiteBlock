# SiteBlock

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

SiteBlock is a Chrome browser extension that empowers users to take control of their browsing experience. With SiteBlock, you can effortlessly block specific websites that you find distracting or irrelevant, allowing you to stay focused and boost your productivity.

## Features

- **Website Blocking:** Easily block websites by adding them to the extension's settings. Once added, these websites will be redirected to a "blocked" page whenever you attempt to access them.
- **Simplicity:** With an intuitive user interface, SiteBlock makes it simple to manage your list of blocked websites.
- **Privacy-Focused:** Your blocked websites list is stored locally on your device, ensuring your data remains private and secure.

## Installation

[Install the extension from the Chrome Web Store](https://chrome.google.com/webstore/detail/siteblock/ghjkimampnaopgkijfpdmjljnolonadk/)

## Usage

1. Install the extension.

2. Open the extension options page from the browser menu.

3. Enter the websites you want to block, one per line.

4. Save your settings.

5. Visit a blocked website to see the redirection.

## Blocking rules

- `facebook.com` blocks the apex domain plus all subdomains (`www`, `m`, …).
- `*.example.com` blocks subdomains (and the apex, via DNR).
- `*keyword*` blocks any host containing a word (e.g. `*bet*`).
- `youtube.com/shorts` blocks one section of a site but leaves the rest alone.

Pasting full URLs works too — `https://www.facebook.com/` normalizes to `facebook.com`.

## Testing

No dependencies, just Node 18+ (built-in `node:test` runner):

```sh
npm test
```

128 tests across 5 files: matcher unit tests, background worker tests
(behind a functional in-memory `chrome.*` mock), content-script tests,
manifest/HTML integrity tests, and end-to-end user journeys
(install → block → navigate → stats → temp-allow → pause/resume → unblock).

## Contributing

Contributions are welcome! Please refer to our [Contributing Guidelines](CONTRIBUTING.md) for more details.

## License

This project is licensed under the [MIT License](LICENSE.md).

## Contact

If you have any questions or feedback, feel free to contact me using any contact methods listed on [my website](https://salikkhan.com).

## Acknowledgements

- Used [new.css](https://newcss.net) for html pages.
