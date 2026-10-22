export interface CrossVenueAlertPayload {
  sdexPrice: number
  ammPrice: number
  diffPct: number
}

export function checkCrossVenueDivergence(
  sdexPrice: number,
  ammPrice: number,
  threshold: number = 0.05,
  onAlert: (payload: CrossVenueAlertPayload) => void = () => {}
): boolean {
  if (!isFinite(sdexPrice) || !isFinite(ammPrice)) return false
  if (sdexPrice <= 0 || ammPrice <= 0) return false

  const diff = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)
  const diffPct = diff
  if (diffPct > threshold) {
    onAlert({ sdexPrice, ammPrice, diffPct })
    return true
  }
  return false
}
