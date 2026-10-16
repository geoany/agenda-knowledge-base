/**
 * A set of line-drawn icons, a single stroke width, no external library.
 * They inherit the text colour (`currentColor`), so the active state is handled
 * in CSS without an icon variant.
 */
const S = ({ children, size = 18, ...rest }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" {...rest}>{children}</svg>
)

export const IconWeek = p => (
  <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M3 9h18M9 9v10.5M15 9v10.5" /></S>
)
export const IconToday = p => (
  <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /><circle cx="12" cy="14.5" r="2" fill="currentColor" stroke="none" /></S>
)
export const IconChat = p => (
  <S {...p}><path d="M20.5 12.5c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L4 20.5l1.5-3.4A6.6 6.6 0 0 1 3.5 12.5c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" /></S>
)
export const IconCalendar = p => (
  <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /><path d="M7.5 13h2M11 13h2M14.5 13h2M7.5 16.5h2M11 16.5h2" /></S>
)
export const IconSearch = p => (
  <S {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.6-3.6" /></S>
)
export const IconLeft = p => (<S {...p}><path d="m14.5 5-7 7 7 7" /></S>)
export const IconRight = p => (<S {...p}><path d="m9.5 5 7 7-7 7" /></S>)
export const IconSend = p => (<S {...p}><path d="M12 19V5M6 11l6-6 6 6" /></S>)
export const IconPlus = p => (<S {...p}><path d="M12 5.5v13M5.5 12h13" /></S>)
export const IconUndo = p => (<S {...p}><path d="M4 9.5h10a5 5 0 0 1 0 10h-5" /><path d="m8 5.5-4 4 4 4" /></S>)

/** Side panel: the filled rectangle shows the side that collapses. */
export const IconPanelLeft = p => (
  <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M9.5 4.5v15" /><rect x="3.8" y="5.3" width="5" height="13.4" rx="1.2" fill="currentColor" stroke="none" opacity=".45" /></S>
)
export const IconPanelRight = p => (
  <S {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M14.5 4.5v15" /><rect x="15.2" y="5.3" width="5" height="13.4" rx="1.2" fill="currentColor" stroke="none" opacity=".45" /></S>
)

export const IconSun = p => (
  <S {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" /></S>
)
export const IconMoon = p => (
  <S {...p}><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></S>
)
/** Evening review: we go back over the day and tick off what is done. */
export const IconReview = p => (
  <S {...p}><path d="M4 6.5h9M4 12h9M4 17.5h5" /><path d="m15.5 16.2 2 2 4-4.4" /></S>
)
/** The streak of consecutive days. */
export const IconFlame = p => (
  <S {...p}><path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-1.7.8-3.1 1.6-4.1.3 1 1 1.9 1.9 2.2C10.2 8 12 6 12 3Z" /></S>
)
export const IconCheck2 = p => (<S {...p}><path d="m4.5 12.5 5 5 10-11" /></S>)
/* Curved arrow forward: a line that leaves again for another day. */
export const IconReport = p => (<S {...p}><path d="M20 14.5H10a5 5 0 0 1 0-10h5" /><path d="m16.5 10.5 4 4-4 4" /></S>)
/** Dictation: a microphone. The foot stroke keeps it from looking like an eraser. */
export const IconMic = p => (
  <S {...p}><rect x="9" y="2.8" width="6" height="11.4" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.2M9 21.2h6" /></S>
)

/** Sending an instruction to a worker: a small wrench. */
export const IconWrench = p => (
  <S {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94Z" /></S>
)

/** Claude Code: Claude's star, the official outline (simple-icons "claude"),
 *  in its brand colour. No in-house variant, the star IS the logo. */
export const IconClaude = ({ size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="#D97757" aria-hidden="true">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
)

/** The cheap worker (Claude Code on a cheaper model). Kept apart from the
 *  Claude logo: a terminal prompt, which follows the text colour. */
export const IconTerminal = p => (
  <S {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" /></S>
)

/** The application's mark: three list lines, the first one ticked. */
export const IconLogo = ({ size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <rect width="24" height="24" rx="6" fill="url(#g)" />
    <defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="24">
      <stop stopColor="#68a4f0" /><stop offset="1" stopColor="#2f6bbd" />
    </linearGradient></defs>
    <path d="m6 11.6 2 2 4-4.2" stroke="#0d1522" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 17h12" stroke="#0d1522" strokeWidth="1.9" strokeLinecap="round" opacity=".65" />
  </svg>
)

/* The set of gestures of a line: one drawing per gesture, used identically by
   the hover buttons, the phone bar and the pop-ups. No more "×" or "+" typed
   on the keyboard as an icon. */
export const IconClose = p => (<S {...p}><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></S>)
export const IconRedo = p => (<S {...p}><path d="M20 9.5H10a5 5 0 0 0 0 10h5" /><path d="m16 5.5 4 4-4 4" /></S>)
export const IconClock = p => (<S {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></S>)
export const IconNote = p => (<S {...p}><path d="M5 5.5h14M5 10h14M5 14.5h9" /><path d="m15.5 19 4-4" /></S>)
export const IconTrash = p => (<S {...p}><path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5" /></S>)
export const IconIndent = p => (<S {...p}><path d="M4 5.5h16M10 10h10M10 14h10M4 18.5h16" /><path d="m4 9.5 3 2.5-3 2.5" /></S>)
export const IconOutdent = p => (<S {...p}><path d="M4 5.5h16M10 10h10M10 14h10M4 18.5h16" /><path d="m7 9.5-3 2.5 3 2.5" /></S>)
export const IconUp = p => (<S {...p}><path d="M12 19V5M6 11l6-6 6 6" /></S>)
export const IconDown = p => (<S {...p}><path d="M12 5v14M6 13l6 6 6-6" /></S>)
export const IconCheckbox = p => (<S {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12.5 3 3 5-6" /></S>)
export const IconGraph = p => (
  <S {...p}><circle cx="6" cy="17.5" r="2.6" /><circle cx="17.5" cy="18" r="2.4" /><circle cx="12.5" cy="6.5" r="2.8" /><path d="m8 15.6 3-6.6M14.6 8.7l2.2 6.9" /></S>
)
