// Copy text to the clipboard. navigator.clipboard only exists on HTTPS or
// localhost, and the dashboard is usually opened as http://<robot-ip>:8080,
// so fall back to the old textarea + execCommand('copy') path there.
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy was refused')
    }
  } finally {
    document.body.removeChild(area)
  }
}
