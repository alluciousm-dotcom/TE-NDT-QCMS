import React, { useEffect, useRef, useState } from 'react'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const SCALE_STEP = 0.25

// Renders onto a canvas with pdf.js instead of an <iframe src="...pdf">. An
// iframe hands the PDF to the browser's own viewer, and that quietly
// downloads instead of displaying it whenever the browser (or an org policy,
// or a mobile browser with no PDF plugin) is set to "download PDFs" rather
// than open them — confirmed happening here even though the server sends no
// download-forcing header. Rendering it ourselves sidesteps that entirely.
//
// standardFontDataUrl/cMapUrl point at pdf.js's own font-substitution data
// (copied into public/pdfjs at build time — Vite can't import a whole
// directory as a URL). Without them, any text using a standard font the PDF
// doesn't embed — nearly always most of the body text on a scanned
// certificate, since only a producer's logo/signature/decorative fonts tend
// to be embedded — silently fails to render instead of falling back, which
// is exactly the "half the certificate is missing" bug this fixes.
//
// pdf.js itself is loaded on demand so it never costs anything until someone
// actually opens a PDF.
export default function PdfPreview({ url }) {
  const canvasRef = useRef(null)
  const [pdfDoc, setPdfDoc] = useState(null)
  const [page, setPage] = useState(1)
  const [numPages, setNumPages] = useState(1)
  const [scale, setScale] = useState(1.5)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setPdfDoc(null); setPage(1); setScale(1.5)
    ;(async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
        const base = import.meta.env.BASE_URL
        const doc = await pdfjsLib.getDocument({
          url,
          standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
          cMapUrl: `${base}pdfjs/cmaps/`,
          cMapPacked: true
        }).promise
        if (cancelled) return
        setPdfDoc(doc)
        setNumPages(doc.numPages)
      } catch {
        if (!cancelled) setError('Could not render this PDF here. Use "Open in a new tab" below.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return
    let cancelled = false
    ;(async () => {
      const pdfPage = await pdfDoc.getPage(page)
      if (cancelled) return
      const viewport = pdfPage.getViewport({ scale })
      const canvas = canvasRef.current
      canvas.width = viewport.width
      canvas.height = viewport.height
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    })()
    return () => { cancelled = true }
  }, [pdfDoc, page, scale])

  if (error) return <p className="small muted">{error}</p>
  if (loading) return <p className="small muted">Loading preview…</p>

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, justifyContent: 'center' }}>
        <button
          className="small" disabled={scale <= MIN_SCALE}
          onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)))}
        >Zoom out</button>
        <span className="small muted mono">{Math.round(scale * 100)}%</span>
        <button
          className="small" disabled={scale >= MAX_SCALE}
          onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)))}
        >Zoom in</button>
        {numPages > 1 && (
          <>
            <button className="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span className="small muted">Page {page} of {numPages}</span>
            <button className="small" disabled={page >= numPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </>
        )}
      </div>
      <div className="pdf-scroll">
        <canvas ref={canvasRef} className="pdf-canvas" />
      </div>
    </div>
  )
}