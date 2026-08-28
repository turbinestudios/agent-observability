import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { RELEASES } from '../changelog/releases';
import type { Span } from '../changelog/parseChangelog';

/**
 * What's new: the app's own release notes, read from the `CHANGELOG.md` that
 * ships with it.
 *
 * A dialog rather than a view because it is something you glance at and dismiss,
 * not a destination you navigate to and come back from. Dismissal is deliberately
 * easy — Escape, the backdrop, the close button — since nothing here is a
 * decision.
 */

interface Props {
  onClose: () => void;
}

/** Render one line's formatted runs. Never HTML — real elements only. */
function Line({ spans }: { spans: Span[] }): JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'strong':
            return <strong key={i}>{span.text}</strong>;
          case 'code':
            return <code key={i}>{span.text}</code>;
          case 'link':
            return (
              <a key={i} href={span.href} target="_blank" rel="noreferrer">
                {span.text}
              </a>
            );
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

export function ChangelogDialog({ onClose }: Props): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="changelog-backdrop" onMouseDown={onClose}>
      <div
        className="changelog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        // Clicks inside must not reach the backdrop's dismiss handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="changelog-head">
          <h2 id="changelog-title">What&apos;s new</h2>
          <button type="button" className="changelog-close" ref={closeRef} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </header>

        <div className="changelog-body">
          {RELEASES.length === 0 && <p className="changelog-empty">No release notes yet.</p>}

          {RELEASES.map((release) => (
            <section key={release.version} className="changelog-release">
              <h3>
                <span className="changelog-version">{release.version}</span>
                {release.date !== undefined && (
                  <time className="changelog-date" dateTime={release.date}>
                    {release.date}
                  </time>
                )}
              </h3>
              {release.sections.map((section) => (
                <div key={section.title} className="changelog-section">
                  <h4>{section.title}</h4>
                  <ul>
                    {section.items.map((item, i) => (
                      <li key={i}>
                        <Line spans={item} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
