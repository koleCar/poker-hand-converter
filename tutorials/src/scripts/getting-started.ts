// getting-started: the web app signed out, an account, signing in and the
// shell. Shots: capture/web/getting-started.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'getting-started',
  title: 'Getting started',
  subtitle: 'Sign in, or use Rail without an account, and find your way around the web app',
  where: 'the web app · sign-in dialog, tabs and menu',
  next: 'convert',
  chapters: [
    {
      title: 'Signed out',
      steps: [
        {
          shot: 'offer',
          focus: 'dialog',
          fill: 0.55,
          highlight: 'dialog',
          caption: 'On your first visit Rail offers to sign in. Your hands stay private to your account.',
          seconds: 4.5,
        },
        {
          shot: 'offer',
          focus: 'dialog',
          fill: 0.55,
          cursor: 'guest',
          click: true,
          highlight: 'guest',
          caption: 'Or continue without an account: converting works signed out; saving and sharing need an account.',
          seconds: 5,
        },
        {
          shot: 'guest',
          focus: 'tabs',
          fill: 0.5,
          highlight: 'tabs',
          caption: 'Signed out you have the forum, the converter (Upload hand) and Learn.',
          seconds: 4,
        },
      ],
    },
    {
      title: 'Your account',
      steps: [
        {
          shot: 'create',
          focus: 'dialog',
          fill: 0.55,
          highlight: ['email', 'password'],
          caption: 'Create an account with an email address and a password, then confirm the address from the link Rail sends.',
          seconds: 5,
        },
        {
          shot: 'sign-in',
          focus: 'dialog',
          fill: 0.55,
          cursor: 'submit',
          click: true,
          highlight: 'submit',
          caption: 'Signing in uses the same dialog. A short robot check runs inside it first.',
          seconds: 4.5,
        },
        {
          shot: 'signed-in',
          focus: 'tabs',
          fill: 0.75,
          highlight: ['user', 'bell', 'status'],
          caption: 'Signed in: your name, the notifications bell, and how many hands your library stores.',
          seconds: 4.5,
        },
        {
          shot: 'menu',
          focus: 'menu',
          fill: 0.4,
          cursor: 'user',
          click: true,
          highlight: 'menu',
          caption: 'Your menu holds your profile, saved posts, Settings and Sign out.',
          seconds: 4,
        },
      ],
    },
    {
      title: 'Finding your way',
      steps: [
        {
          shot: 'upload',
          cursor: 'tab',
          click: true,
          highlight: 'drop',
          caption: 'Upload hand opens the converter: drop your hand-history files there to build your library.',
          seconds: 4.5,
        },
        {
          shot: 'full-tabs',
          focus: 'tabs',
          fill: 0.75,
          highlight: ['library', 'stats', 'analysis'],
          caption: 'Once your library has hands, Hand history, Statistics and Analysis join the tabs.',
          seconds: 4.5,
        },
        {
          shot: 'full-tabs',
          focus: 'lang',
          fill: 0.25,
          maxZoom: 1.1,
          highlight: 'lang',
          caption: 'EN and HR switch the whole app between English and Croatian.',
          seconds: 3.5,
        },
        {
          shot: 'footer',
          focus: 'footer',
          fill: 0.4,
          maxZoom: 1.1,
          highlight: 'footer',
          caption: 'The terms of use, the privacy policy and the takedown page are linked at the foot of every page.',
          seconds: 4,
        },
      ],
    },
  ],
};
