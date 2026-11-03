import type { DiscoveryRound } from '@fairbuy/core';

export default function DiscoveryActivity({ round }: { round: DiscoveryRound }) {
  const activities = round.activities ?? [];
  const current = activities.at(-1);
  if (!current) return null;
  const running = round.status === 'running';
  return <section className="research-activity panel" aria-label="Research activity">
    {running && <div className="research-current"><span className="eyebrow">WORKING ON IT</span><p role="status" aria-live="polite" aria-atomic="true">{current.message}</p></div>}
    <details>
      <summary>{running ? 'Recent research activity' : 'Research activity'} ({activities.length})</summary>
      <ol>{activities.map((activity, index) => <li key={`${activity.at}-${index}`}>
        <time className="micro" dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <span>{activity.message}</span>
      </li>)}</ol>
    </details>
  </section>;
}
