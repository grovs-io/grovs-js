'use client';

import Link from 'next/link';
import { trigger } from './grovs';

export function HostPage({ title, href, label, id }) {
  return (
    <main>
      <h1>{title}</h1>
      <input id="host-field" placeholder="Type here" />
      <button id="host-trigger" type="button" onClick={trigger}>
        Trigger
      </button>
      <Link id={id} href={href}>
        {label}
      </Link>
    </main>
  );
}
