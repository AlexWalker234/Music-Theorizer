# Music Theorizer screens for Figma

This plugin draws all 8 screens of the app as editable Figma layers (text, shapes, the fretboard as vectors) on a page called **Hi-fi app screens**. Each screen was captured from the running app, so it matches what the app shows.

Screens: Free Play, Scale Mode, Jam Mode (Play along, Riff Mode, Guitar), AI Setup, Settings, and Guitar in dark mode.

## Run it (Figma desktop app)

1. Unzip this folder somewhere on your computer.
2. Open the Figma file in the **Figma desktop app** (development plugins don't run in the browser).
3. Menu › **Plugins › Development › Import plugin from manifest…** and pick `manifest.json` from this folder.
4. Menu › **Plugins › Development › Music Theorizer screens**. It takes a few seconds and says "Built 8 screens" when done.

Running it again replaces the screens it made, so it's safe to re-run. It needs the free Google fonts Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, which Figma has built in.

This doesn't use the Figma AI connection, so the Starter plan's call limit doesn't apply.

## Just the pictures

`screens/` has a PNG of each screen. Drag them into Figma if you only need images.
