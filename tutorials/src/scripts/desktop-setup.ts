// The desktop app, from the first launch to a populated window: the
// first-run screen (sign in, the folders Rail found, import everything or
// only new hands), Today while the old hands import, Settings (folders,
// account and sync, appearance), the command palette, and a first look at
// Hands, Reports and Players. Shots: `capture/desktop/capture.ts`
// (`captureDesktopSetup`). Every caption says what the app's code and its
// English strings (`app/src/i18n/en.ts`) do.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'desktop-setup',
  title: 'Setting up the desktop app',
  subtitle: 'Sign in, confirm your hand-history folders, and find your way around',
  where: 'Rail desktop app · first launch, Today, Settings',
  next: 'desktop-app',
  chapters: [
    {
      title: 'First launch',
      steps: [
        {
          shot: 'firstrun',
          caption: 'On first launch Rail opens on its setup screen: sign in, confirm your hand-history folders, open a table.',
          seconds: 4.5,
        },
        {
          shot: 'firstrun',
          focus: 'signInStep',
          cursor: 'signIn',
          click: true,
          highlight: 'signIn',
          caption: 'Sign in opens the sign-in page in your browser. Use offline skips it: Rail works without an account.',
          seconds: 4.5,
        },
        {
          shot: 'firstrun-signing-in',
          focus: 'signInStep',
          highlight: 'waiting',
          caption: 'The window waits while you finish in the browser, with the time left and a way to open the page again.',
          seconds: 4,
        },
        {
          shot: 'firstrun-folders',
          focus: 'folderStep',
          highlight: 'folderTable',
          callout: 'Found by Rail',
          caption: 'Rail lists the hand-history folders it found in the rooms’ default places, with their files and last hand.',
          seconds: 4.5,
        },
        {
          shot: 'firstrun-folders',
          focus: 'folderTable',
          highlight: 'addedRow',
          callout: 'Added by you',
          caption: 'Add a folder manually… picks any other folder, here a Winamax history folder.',
          seconds: 4,
        },
        {
          shot: 'firstrun-folders',
          focus: 'importAll',
          highlight: ['importAll', 'onlyNew'],
          fill: 0.5,
          caption: 'Import everything reads the hands already there; Only new hands starts from the hands you play from now on.',
          seconds: 5,
        },
        {
          shot: 'firstrun-folders',
          focus: 'watch',
          cursor: 'watch',
          click: true,
          highlight: 'watch',
          fill: 0.4,
          caption: 'Watch 3 folders confirms the choice.',
          seconds: 3,
        },
        {
          shot: 'firstrun-done',
          focus: 'tableStep',
          cursor: 'goToday',
          click: true,
          highlight: 'watching',
          caption: 'Rail is watching 3 folders. Play as usual: Rail reads each hand as your room writes it.',
          seconds: 4,
        },
      ],
    },
    {
      title: 'Today',
      steps: [
        {
          shot: 'today',
          highlight: ['accountLine', 'syncLine', 'hudLine'],
          caption: 'Today opens with one line each for the account, sync with the web and the HUD.',
          seconds: 4.5,
        },
        {
          shot: 'today',
          focus: 'sessionTiles',
          highlight: 'sessionTiles',
          caption: 'The current session: result in money and big blinds, hands, hands per hour and tables.',
          seconds: 4,
        },
        {
          shot: 'today-import',
          focus: 'importTable',
          highlight: 'backfill',
          callout: 'Old hands importing',
          caption: 'Import shows each folder’s state, and the old hands as they import: percent done, files, hands and time left.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Settings',
      steps: [
        {
          shot: 'palette',
          focus: 'paletteList',
          highlight: 'paletteInput',
          fill: 0.5,
          caption: 'Cmd or Ctrl + K opens the command palette from anywhere: screens, hands by number, players, settings, commands.',
          seconds: 4.5,
        },
        {
          shot: 'palette-folders',
          focus: 'paletteList',
          cursor: 'foldersOption',
          click: true,
          highlight: 'foldersOption',
          fill: 0.5,
          caption: 'Typing narrows it: “folders” finds the Settings section for hand-history folders.',
          seconds: 3.5,
        },
        {
          shot: 'settings-folders',
          focus: 'folderCard',
          highlight: 'folderSettings',
          caption: 'Each watched folder can be switched off, include subfolders, be polled on a network drive, or be read as one room.',
          seconds: 5,
        },
        {
          shot: 'settings-folders',
          focus: 'folderCard',
          highlight: ['addFolder', 'findAgain'],
          caption: 'Add a folder, or let Rail find the rooms’ folders again. Removing a folder keeps its hands.',
          seconds: 4,
        },
        {
          shot: 'settings-account',
          focus: 'accountSection',
          highlight: ['signedIn', 'syncStatus'],
          caption: 'Account shows who is signed in and how sync stands: here, syncing 1,200 of 4,000 hands.',
          seconds: 4.5,
        },
        {
          shot: 'settings-account',
          focus: 'syncNow',
          highlight: ['syncNow', 'pauseSync', 'uploadLimit'],
          fill: 0.5,
          caption: 'Sync now, pause sync, and limit the upload speed while a large backlog syncs.',
          seconds: 4,
        },
        {
          shot: 'settings-appearance',
          focus: 'appearance',
          highlight: ['theme', 'density', 'language'],
          caption: 'Appearance: dark, light or the system’s theme, comfortable or compact lists, English or Croatian.',
          seconds: 4.5,
        },
        {
          shot: 'settings-appearance-light',
          focus: 'appearance',
          cursor: 'light',
          click: true,
          highlight: 'theme',
          caption: 'A choice is saved in the settings and applies at once.',
          seconds: 3,
        },
      ],
    },
    {
      title: 'Your hands',
      steps: [
        {
          shot: 'hands',
          highlight: 'filters',
          caption: 'Hands lists every hand, newest first, with filters for room, stakes, position, pot, result and more.',
          seconds: 4.5,
        },
        {
          shot: 'hands-replayer',
          focus: 'replayer',
          highlight: 'replayer',
          caption: 'A hand opens in the replayer, street by street.',
          seconds: 3.5,
        },
        {
          shot: 'hands-replayer',
          focus: 'annotations',
          highlight: ['tags', 'note'],
          fill: 0.6,
          caption: 'Tags and a note per hand; they stay on this computer for now.',
          seconds: 3.5,
        },
        {
          shot: 'reports',
          highlight: 'graph',
          caption: 'Reports: winnings over time with the showdown, non-showdown and all-in EV lines, and the breakdowns below.',
          seconds: 4.5,
        },
        {
          shot: 'players-profile',
          highlight: 'profile',
          caption: 'Players: each opponent’s hands with you, your result against them, statistics, and your colour, labels and note.',
          seconds: 4.5,
        },
      ],
    },
  ],
};
