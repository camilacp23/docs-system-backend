# Fonts of the PDF reports

The PDF generator embeds these fonts so that text outside the WinAnsi set of the standard PDF fonts is drawn
correctly. They are the TrueType files of the official IBM Plex releases, copied unchanged.

| File                    | Release                                                    | Bytes  | SHA-256                                                            |
| ----------------------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `IBMPlexSans-Regular.ttf` | `@ibm/plex-sans@1.1.0` (`ibm-plex-sans.zip`, 2024-11-13)   | 200500 | `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5` |
| `IBMPlexSans-Bold.ttf`    | `@ibm/plex-sans@1.1.0` (`ibm-plex-sans.zip`, 2024-11-13)   | 200872 | `9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f` |
| `IBMPlexMono-Regular.ttf` | `@ibm/plex-mono@2.5.0` (`ibm-plex-mono.zip`, 2026-06-11)   | 173052 | `7c6fbddca4b700be918f5f6183d9bd4464fa427fe435f0b480d77fe2bb8c5a43` |

Source: <https://github.com/IBM/plex/releases> (path `fonts/complete/ttf/` inside each archive). SHA-256 of the
archives as downloaded: `ibm-plex-sans.zip` `fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200`,
`ibm-plex-mono.zip` `6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c`.

License: SIL Open Font License 1.1 (`LICENSE.txt`, the text shipped in both archives, which are identical; only the
line endings were normalized to LF). The fonts are not modified and not sold on their own. They are copied to `dist/`
by `npm run build` (`scripts/copy-sql.mjs`).
