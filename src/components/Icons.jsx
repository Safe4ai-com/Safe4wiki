const base = (size, props) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props,
});

export const SearchIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
);
export const PlusIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.5, ...p })}><path d="M5 12h14" /><path d="M12 5v14" /></svg>
);
export const ArrowRight = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
);
export const StarIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .48.35l5.52.44c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.38a.56.56 0 0 1-.84.61l-4.73-2.89a.56.56 0 0 0-.58 0l-4.73 2.89a.56.56 0 0 1-.84-.6l1.28-5.39a.56.56 0 0 0-.18-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .48-.35z" />
  </svg>
);
export const ShareIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.59 13.51 6.83 3.98" /><path d="m15.41 6.51-6.82 3.98" /></svg>
);
export const MoonIcon = ({ size = 20, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M21.75 15.5A9.72 9.72 0 0 1 18 16.25 9.75 9.75 0 0 1 8.25 6.5c0-1.33.27-2.6.75-3.75A9.75 9.75 0 0 0 2.25 12c0 5.38 4.37 9.75 9.75 9.75a9.75 9.75 0 0 0 9.75-6.25Z" />
  </svg>
);
export const SunIcon = ({ size = 20, ...p }) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
);
export const PencilIcon = ({ size = 20, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.5, ...p })}><path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" /><path d="m15 5 4 4" /></svg>
);
export const ChevronRight = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="m9 18 6-6-6-6" /></svg>
);
export const ChevronDown = ({ size = 14, ...p }) => (
  <svg {...base(size, p)}><path d="m6 9 6 6 6-6" /></svg>
);
export const XIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
export const BoltIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.5, ...p })}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></svg>
);
export const BrainIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.5, ...p })}><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></svg>
);
export const ArrowUp = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
);
export const NodesIcon = ({ size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...p}>
    <circle cx="4" cy="4" r="2.6" /><circle cx="11.5" cy="6.5" r="2.6" /><circle cx="5" cy="12" r="2.6" />
  </svg>
);
export const GearIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const FileIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
);
export const GlobeIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
);
export const DownloadIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>
);
export const LinkIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
);
export const CopyIcon = ({ size = 14, ...p }) => (
  <svg {...base(size, p)}><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
);
export const ExpandIcon = ({ size = 14, ...p }) => (
  <svg {...base(size, p)}><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
);
export const RefreshIcon = ({ size = 14, ...p }) => (
  <svg {...base(size, p)}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
);
export const BackIcon = ({ size = 14, ...p }) => (
  <svg {...base(size, p)}><path d="m15 18-6-6 6-6" /></svg>
);
export const SparkleIcon = ({ size = 22, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z" /><path d="M19 3v4" /><path d="M21 5h-4" /></svg>
);
export const MaximizeIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
);
export const MinimizeIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></svg>
);
export const TrashIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></svg>
);
export const ThumbUpIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M7 10v11" /><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.5 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 3a3.1 3.1 0 0 1 3 2.9Z" /></svg>
);
export const ThumbDownIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="M17 14V3" /><path d="M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.5 3H20a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 21a3.1 3.1 0 0 1-3-2.9Z" /></svg>
);
export const PaperclipIcon = ({ size = 18, ...p }) => (
  <svg {...base(size, { strokeWidth: 1.6, ...p })}><path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" /></svg>
);
export const CheckIcon = ({ size = 16, ...p }) => (
  <svg {...base(size, p)}><path d="M20 6 9 17l-5-5" /></svg>
);
export const InfoIcon = ({ size = 15, ...p }) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
);
