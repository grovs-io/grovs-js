import { HostPage } from './host-page';

export const metadata = { title: 'Host home' };

export default function Home() {
  return <HostPage title="Host home" href="/second" label="Second" id="host-second" />;
}
