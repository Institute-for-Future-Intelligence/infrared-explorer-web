import {
  Ban,
  Camera,
  CircleMinus,
  ClipboardPen,
  Crown,
  Diff,
  ExternalLink,
  EyeOff,
  Flag,
  FolderPlus,
  Image,
  Info,
  Link,
  LogOut,
  Mail,
  MessageCircleQuestionMark,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Ruler,
  Scan,
  Send,
  Settings,
  Share2,
  SquareCheckBig,
  Star,
  StickyNote,
  Thermometer,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';

/** The size every menu row's icon is drawn at. */
export const MENU_ICON_SIZE = 14;

/*
 * The icon of every action row in the site's menus — the cards' ⋮ (My Recordings, Trash, profile,
 * Community, Experiments, classes), the analyzer's ⋮ and right-click menu, the avatar menu, the street
 * view's ⋮ — one lucide glyph per action at one size, so every row of a menu carries one and an action
 * looks the same wherever it is offered. Pickers (sort, time, subject filters) are lists of values, not
 * actions, and stay without.
 */
export const MENU_ICONS = {
  open: <ExternalLink size={MENU_ICON_SIZE} />,
  rename: <Pencil size={MENU_ICON_SIZE} />,
  share: <Share2 size={MENU_ICON_SIZE} />,
  saveAs: <FolderPlus size={MENU_ICON_SIZE} />,
  select: <SquareCheckBig size={MENU_ICON_SIZE} />,
  // Deleting (to the trash or for good) vs. taking an item out of a list it is shown in.
  delete: <Trash2 size={MENU_ICON_SIZE} />,
  remove: <CircleMinus size={MENU_ICON_SIZE} />,
  restore: <RotateCcw size={MENU_ICON_SIZE} />,
  clear: <X size={MENU_ICON_SIZE} />,
  admin: <Crown size={MENU_ICON_SIZE} />,
  // The homepage / class showcase: an outline star to add, the filled heat star while it's in.
  feature: <Star size={MENU_ICON_SIZE} />,
  featured: <Star size={MENU_ICON_SIZE} fill="currentColor" style={{ color: 'var(--ifi-heat)' }} />,
  pin: <Pin size={MENU_ICON_SIZE} />,
  unpin: <PinOff size={MENU_ICON_SIZE} />,
  info: <Info size={MENU_ICON_SIZE} />,
  settings: <Settings size={MENU_ICON_SIZE} />,
  screenshot: <Camera size={MENU_ICON_SIZE} />,
  copyLink: <Link size={MENU_ICON_SIZE} />,
  contact: <Mail size={MENU_ICON_SIZE} />,
  signOut: <LogOut size={MENU_ICON_SIZE} />,
  recordings: <Video size={MENU_ICON_SIZE} />,
  users: <Users size={MENU_ICON_SIZE} />,
  report: <Flag size={MENU_ICON_SIZE} />,
  hide: <EyeOff size={MENU_ICON_SIZE} />,
  takeDown: <Ban size={MENU_ICON_SIZE} />,
  grade: <ClipboardPen size={MENU_ICON_SIZE} />,
  submit: <Send size={MENU_ICON_SIZE} />,
  // The analyzer's frame tools.
  thermometer: <Thermometer size={MENU_ICON_SIZE} />,
  line: <Ruler size={MENU_ICON_SIZE} />,
  annotation: <StickyNote size={MENU_ICON_SIZE} />,
  measuringArea: <Scan size={MENU_ICON_SIZE} />,
  diffReference: <Diff size={MENU_ICON_SIZE} />,
  thumbnail: <Image size={MENU_ICON_SIZE} />,
  askMoment: <MessageCircleQuestionMark size={MENU_ICON_SIZE} />,
};
