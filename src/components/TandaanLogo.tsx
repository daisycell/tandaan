/**
 * The Tandaan logo: four dogs as one 2x2 square.
 *
 * The formation lives here and only here, so the onboarding screen and the app
 * header cannot drift apart. The grid is what guarantees that: `1fr 1fr` cells,
 * a 2px gap, and a single border/radius on the container. No cell is absolutely
 * positioned or independently offset, so no dog can leave the square.
 *
 * Motion is CSS-only. `animated` adds a class and nothing else, so there are no
 * JS timers to leak on unmount and the stylesheet's prefers-reduced-motion
 * block switches it off for anyone who asked for less movement.
 */
import type { CSSProperties } from 'react'

export function TandaanLogo({ size, animated = false, className = '' }: {
  size: number
  animated?: boolean
  className?: string
}) {
  // Fixed order: d1 d2 / d3 d4.
  const dogs = ['d1', 'd2', 'd3', 'd4']

  return (
    <div
      className={`tandaan-logo${animated ? ' is-animated' : ''}${className ? ` ${className}` : ''}`}
      // The size is passed as a custom property rather than inline width/height
      // so the media queries below can still shrink the header logo on narrow
      // screens. An inline width/height would outrank them and pin it at 44px.
      style={{ '--logo-size': `${size}px` } as CSSProperties}
      role="img"
      aria-label="Tandaan"
    >
      {dogs.map(dog => (
        <img
          key={dog}
          className="tandaan-logo-cell"
          src={`/icons/logo-${dog}.png`}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ))}
    </div>
  )
}