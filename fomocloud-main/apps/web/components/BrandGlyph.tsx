// MemeCloud brand mark: an ascending momentum trail through three growing
// network nodes — reads as rising meme momentum + connected on-chain
// wallets, not a literal letter, cloud, or coin.
export function BrandGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22 68 C 34 68, 40 55, 48 46 C 56 37, 64 33, 82 27" stroke="#161104" strokeWidth="9" fill="none" strokeLinecap="round" />
      <circle cx="22" cy="68" r="8" fill="#161104" />
      <circle cx="49" cy="45" r="9.5" fill="#161104" />
      <circle cx="82" cy="27" r="11" fill="#161104" />
    </svg>
  );
}
