import { type PointerEvent, type ReactNode, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

type Props = {
  children: ReactNode
  onDelete: () => void
}

type Axis = 'undecided' | 'x' | 'y'

export default function SwipeToDelete({ children, onDelete }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const startRef = useRef({ x: 0, y: 0, active: false, axis: 'undecided' as Axis })
  const offsetRef = useRef(0)
  const widthRef = useRef(320)
  const deleteTimerRef = useRef<number | null>(null)

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (deleting) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, textarea, select')) return
    widthRef.current = event.currentTarget.clientWidth || 320
    startRef.current = { x: event.clientX, y: event.clientY, active: true, axis: 'undecided' }
    offsetRef.current = offset
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current.active || deleting) return
    const dx = event.clientX - startRef.current.x
    const dy = event.clientY - startRef.current.y

    if (startRef.current.axis === 'undecided') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx)) {
        startRef.current.axis = 'y'
        startRef.current.active = false
        setDragging(false)
        setArmed(false)
        return
      }
      startRef.current.axis = 'x'
    }

    if (startRef.current.axis !== 'x') return
    event.preventDefault()

    const maxSwipe = Math.max(220, widthRef.current * 0.96)
    const next = Math.max(-maxSwipe, Math.min(0, offsetRef.current + dx))
    const threshold = widthRef.current * 0.35
    offsetRef.current = next
    setOffset(next)
    setArmed(next <= -threshold)
  }

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current.active && startRef.current.axis !== 'x') return
    startRef.current.active = false
    setDragging(false)

    const threshold = widthRef.current * 0.35
    const currentOffset = offsetRef.current

    if (currentOffset <= -threshold) {
      setArmed(false)
      setDeleting(true)
      setOffset(-widthRef.current)
      offsetRef.current = -widthRef.current
      if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = window.setTimeout(onDelete, 180)
      return
    }

    setArmed(false)
    const snap = currentOffset < -56 ? -96 : 0
    setOffset(snap)
    offsetRef.current = snap
    if (snap !== 0) {
      window.setTimeout(() => {
        setOffset(0)
        offsetRef.current = 0
      }, 160)
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    startRef.current.active = false
    setDragging(false)
    setArmed(false)
    if (!deleting) {
      setOffset(0)
      offsetRef.current = 0
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className={deleting ? 'swipe-shell deleting' : 'swipe-shell'} aria-label="Swipe left to delete">
      <div className={armed ? 'swipe-delete-bg armed' : 'swipe-delete-bg'}>
        <div className="swipe-delete-hint"><Trash2 size={19} /><span>{armed ? 'Release to delete' : 'Swipe left to delete'}</span></div>
      </div>
      <div
        className={dragging ? 'swipe-content dragging' : 'swipe-content'}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finish}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={() => {
          if (startRef.current.active) {
            startRef.current.active = false
            setDragging(false)
          }
        }}
      >
        {children}
      </div>
    </div>
  )
}
