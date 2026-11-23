// Minimal stroke icon set (24px grid, currentColor).
type P = { size?: number };
const S = ({ size = 18, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const IconDecks = (p: P) => <S {...p}><rect x="4" y="6" width="13" height="14" rx="2.5" /><path d="M8 3.5h9.5A2.5 2.5 0 0 1 20 6v10" /></S>;
export const IconFolder = (p: P) => <S {...p}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></S>;
export const IconPlay = (p: P) => <S {...p}><path d="M7 5.5v13l11-6.5z" /></S>;
export const IconImport = (p: P) => <S {...p}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></S>;
export const IconSearch = (p: P) => <S {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></S>;
export const IconSun = (p: P) => <S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2m0 15v2M4.6 4.6 6 6m12 12 1.4 1.4M2.5 12h2m15 0h2M4.6 19.4 6 18M18 6l1.4-1.4" /></S>;
export const IconMoon = (p: P) => <S {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></S>;
export const IconLogout = (p: P) => <S {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></S>;
export const IconPlus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const IconMenu = (p: P) => <S {...p}><path d="M4 7h16M4 12h16M4 17h16" /></S>;
export const IconClose = (p: P) => <S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>;
export const IconGear = (p: P) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>;
export const IconFlame = (p: P) => <S {...p}><path d="M12 21c4 0 7-2.7 7-6.6 0-3.6-2.5-5.9-4-8.4-.6 2-1.6 3-3 3.5C12 6.6 10.6 4.4 8.5 3c.3 3-1.5 5-3 7.2A7 7 0 0 0 5 14.4C5 18.3 8 21 12 21z" /></S>;
export const IconKey = (p: P) => <S {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-4 4 3 3m-5-1 2 2" /></S>;
export const IconUser = (p: P) => <S {...p}><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" /></S>;
export const IconUsers = (p: P) => <S {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.7.6 2.9 2 3.5 4.2" /></S>;
export const IconShield = (p: P) => <S {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z" /></S>;
export const IconPlug = (p: P) => <S {...p}><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21" /></S>;
export const IconMail = (p: P) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></S>;
export const IconMonitor = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></S>;
export const IconPalette = (p: P) => <S {...p}><path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.5-2-.3-1.3.4-2.5 1.9-2.5H18a3 3 0 0 0 3-3C21 7.6 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></S>;
export const IconPasskey = (p: P) => <S {...p}><circle cx="9" cy="7.5" r="3.5" /><path d="M3 19c.8-3 3-4.5 6-4.5 1.2 0 2.3.2 3.2.7M18 11.5a2.5 2.5 0 1 0-1 2v5.5l1.2 1.2 1.3-1.3-1-1 1-1-1-1" /></S>;
export const IconEye = (p: P) => <S {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></S>;
export const IconEyeOff = (p: P) => <S {...p}><path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.5 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /></S>;
export const IconTrash = (p: P) => <S {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" /></S>;
export const IconCopy = (p: P) => <S {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></S>;
export const IconCheck = (p: P) => <S {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></S>;
export const IconSidebar = (p: P) => <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9 4.5v15" /></S>;
export const IconChevronUpDown = (p: P) => <S {...p}><path d="m8 9 4-4 4 4M8 15l4 4 4-4" /></S>;
export const IconPencil = (p: P) => <S {...p}><path d="m15 5 4 4M4 20l1-4.5L16 4.5a2 2 0 0 1 3 0l.5.5a2 2 0 0 1 0 3L8.5 19z" /></S>;
export const IconChart = (p: P) => <S {...p}><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" /></S>;
export const IconHome = (p: P) => <S {...p}><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H14V15h-4v5.5H5.5A1.5 1.5 0 0 1 4 19z" /></S>;
export const IconGitHub = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z" /></svg>
);
export const IconGoogle = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" /><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" /><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z" /><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" /></svg>
);
export const IconUndo = (p: P) => <S {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></S>;
export const IconRedo = (p: P) => <S {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></S>;
