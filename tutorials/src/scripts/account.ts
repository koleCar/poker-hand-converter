// account: Settings, your data, deleting the account, billing. Shots:
// capture/web/account.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'account',
  title: 'Your account',
  subtitle: 'Settings, your plan, downloading your data and deleting your account',
  where: 'your menu → Settings · /settings',
  next: 'desktop-setup',
  chapters: [
    {
      title: 'Settings',
      steps: [
        {
          shot: 'menu',
          focus: 'settings',
          fill: 0.3,
          maxZoom: 1.1,
          cursor: 'settings',
          click: true,
          highlight: 'settings',
          caption: 'Settings is in your menu.',
          seconds: 3,
        },
        {
          shot: 'settings',
          focus: 'language',
          fill: 0.55,
          highlight: ['language', 'username'],
          caption: 'Choose the language and your username: your public name on the forum and your profile address.',
          seconds: 5,
        },
        {
          shot: 'settings',
          focus: 'plan',
          fill: 0.6,
          highlight: 'plan',
          caption: 'Your plan and your library. In early access every feature is open and paid plans are not on sale yet.',
          seconds: 5.5,
        },
        {
          shot: 'settings',
          focus: 'password',
          fill: 0.5,
          highlight: 'password',
          caption: 'Change your password here.',
          seconds: 3,
        },
      ],
    },
    {
      title: 'Your data',
      steps: [
        {
          shot: 'export',
          focus: 'data',
          fill: 0.6,
          highlight: 'options',
          caption: 'Download my data builds one ZIP in your browser: profile, hands, notes, charts, forum posts and more.',
          seconds: 5,
        },
        {
          shot: 'export',
          focus: 'ready',
          fill: 0.5,
          cursor: 'save',
          highlight: ['ready', 'save'],
          caption: 'When it is ready, save the file. No copy is kept on Rail’s servers.',
          seconds: 4.5,
        },
      ],
    },
    {
      title: 'Leaving',
      steps: [
        {
          shot: 'delete',
          focus: 'happens',
          fill: 0.55,
          highlight: 'happens',
          caption: 'Delete account says exactly what goes: hands, statistics, notes, shares, and your forum content.',
          seconds: 5,
        },
        {
          shot: 'delete',
          focus: 'confirm',
          fill: 0.5,
          highlight: ['confirm', 'password', 'button'],
          caption: 'Type your username and your password to confirm. It cannot be undone, so download your data first.',
          seconds: 5,
        },
        {
          shot: 'billing-cancel',
          focus: 'heading',
          fill: 0.5,
          highlight: 'back',
          caption: 'Leave a checkout and nothing is charged; Back to your plan returns to Settings.',
          seconds: 4,
        },
      ],
    },
  ],
};
