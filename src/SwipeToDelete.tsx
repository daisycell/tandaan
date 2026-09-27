import { type PointerEvent, type ReactNode, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

type Props = {
  children: ReactNode
  onDelete: () => void
  label?: string
}

const REVEAL_WIDTH = 92
const DELETE_THRESHOLD = 108

export default function SwipeToDelete({ children, onDelete, label = 'Delete' }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, y: 0, active: false })
  const offsetRef = useRef(0)

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, textarea, select')) return
    startRef.current = { x: event.clientX, y: event.clientY, active: true }
    offsetRef.current = offset
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current.active) return
    const dx = event.clientX - startRef.current.x
    const dy = event.clientY - startRef.current.y
    if (Math.abs(dy) > Math.abs(dx) + 8) return
    const next = Math.max(-REVEAL_WIDTH, Math.min(0, offsetRef.current + dx))
    setOffset(next)
  }

  const finish = () => {
    startRef.current.active = false
    setDragging(false)
    if (offset <= -DELETE_THRESHOLD) {
      onDelete()
      setOffset(0)
      return
    }
    setOffset(offset < -45 ? -REVEAL_WIDTH : 0)
  }

  const handlePointerCancel = () => {
    startRef.current.active = false
    setDragging(false)
    setOffset(offset < -45 ? -REVEAL_WIDTH : 0)
  }

  return (
    <div className="swipe-shell">
      <div className="swipe-delete-bg">
        <button className="swipe-delete-button" onClick={onDelete} aria-label={label}>
          <Trash2 size={17} />
          <span>{label}</span>
        </button>
      </div>
      <div
        className={dragging ? 'swipe-content dragging' : 'swipe-content'}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finish}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
      >
        {children}
      </div>
    </div>
  )
}
