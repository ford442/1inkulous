export type InputSnapshot = {
  keys: ReadonlySet<string>
}

export type Input = {
  snapshot: () => InputSnapshot
  endFrame: () => void
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>()
  const pressedThisFrame = new Set<string>()

  const onKeyDown = (event: KeyboardEvent) => {
    keys.add(event.code)
    pressedThisFrame.add(event.code)
  }

  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code)
  }

  const onBlur = () => {
    keys.clear()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  canvas.addEventListener('click', () => {
    canvas.focus()
  })

  canvas.tabIndex = 0
  canvas.focus()

  return {
    snapshot() {
      return { keys }
    },
    endFrame() {
      pressedThisFrame.clear()
    },
  }
}
