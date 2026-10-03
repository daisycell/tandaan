import { type PointerEvent, type ReactNode, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

type Props = {
  children: ReactNode
  onDelete: () => void
  showHint?: boolean
}

export default function SwipeToDelete({ children, onDelete, showHint = false }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false)
  const startRef = useRef({ x: 0, y: 0, active: false })
  const offsetRef = useRef(0)
  const widthRef = useRef(320)

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, textarea, select')) return
    widthRef.current = event.currentTarget.clientWidth || 320
    startRef.current = { x: event.clientX, y: event.clientY, active: true }
    offsetRef.current = offset
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current.active) return
    const dx = event.clientX - startRef.current.x
    const dy = event.clientY - startRef.current.y
    if (Math.abs(dy) > Math.abs(dx) + 10) return

    const maxSwipe = Math.max(240, widthRef.current * 0.92)
    const next = Math.max(-maxSwipe, Math.min(0, offsetRef.current + dx))
    const threshold = widthRef.current * 0.72
    setOffset(next)
    setArmed(next <= -threshold)
  }

  const finish = () => {
    startRef.current.active = false
    setDragging(false)
    const threshold = widthRef.current * 0.72
    if (offset <= -threshold) {
      setArmed(false)
      setOffset(-widthRef.current)
      window.setTimeout(onDelete, 110)
      return
    }
    setArmed(false)
    setOffset(offset < -56 ? -110 : 0)
  }

  const handlePointerCancel = () => {
    startRef.current.active = false
    setDragging(false)
    setArmed(false)
    setOffset(0)
  }

  return (
    <div className="swipe-shell" aria-label="Swipe left to delete">
      <div className={armed ? 'swipe-delete-bg armed' : 'swipe-delete-bg'}>
        <div className="swipe-delete-hint">
          <Trash2 size={19} />
          {showHint && <span>{armed ? 'Release to delete' : 'Swipe left to delete'}</span>}
          {!showHint && armed && <span>Release to delete</span>}
        </div>
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
