import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getNavigationAvailability } from '../router';
import { Icon } from './Icon';

interface AppTitleBarProps {
  /** When provided, the logo becomes a back button */
  onBack?: () => void;
  onOpenSettings?: () => void;
}

export function AppTitleBar({ onBack, onOpenSettings }: AppTitleBarProps) {
  const t = useT();
  const [navState, setNavState] = useState(() => getNavigationAvailability());
  const handleBack = onBack ?? (() => window.history.back());
  const handleForward = () => window.history.forward();

  useEffect(() => {
    const sync = () => setNavState(getNavigationAvailability());
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const mark = onBack ? (
    <button
      type="button"
      className="entry-titlebar-mark"
      onClick={onBack}
      title={t('project.backToProjects')}
      aria-label={t('project.backToProjects')}
      style={{ cursor: 'pointer' }}
    >
      <img src="/app-icon.png" alt="" className="brand-mark-img" draggable={false} />
    </button>
  ) : (
    <span className="entry-titlebar-mark" aria-hidden>
      <img src="/app-icon.png" alt="" className="brand-mark-img" draggable={false} />
    </span>
  );

  return (
    <div className="entry-titlebar">
      <div className="entry-titlebar-left">
        {mark}
        <div className="entry-titlebar-nav" aria-label="页面导航">
          <button
            type="button"
            className="entry-titlebar-nav-btn"
            onClick={handleBack}
            disabled={!navState.canGoBack}
            title="后退"
            aria-label="后退"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M7.82843 10.9999H20V12.9999H7.82843L13.1924 18.3638L11.7782 19.778L4 11.9999L11.7782 4.22168L13.1924 5.63589L7.82843 10.9999Z" />
            </svg>
          </button>
          <button
            type="button"
            className="entry-titlebar-nav-btn"
            onClick={handleForward}
            disabled={!navState.canGoForward}
            title="前进"
            aria-label="前进"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z" />
            </svg>
          </button>
        </div>
        <span className="entry-titlebar-name">{t('app.brand')}</span>
      </div>
      <div className="entry-titlebar-right">
        <button
          type="button"
          className="entry-titlebar-icon-btn"
          onClick={onOpenSettings}
          title={t('entry.openSettingsTitle')}
          aria-label={t('entry.openSettingsAria')}
        >
          <Icon name="pen-tool" size={16} />
        </button>
      </div>
    </div>
  );
}
