package input

// Only a provider can confirm a deterministic relation to screen pixels.
type PointerPrediction struct {
	PixelsPerMM   float64
	Width, Height int
}
type PointerPredictionProvider interface {
	PointerPrediction() (PointerPrediction, bool)
	// Host-monotonic microseconds after preceding input, comparable to capture.
	PointerFence() (uint64, bool)
}
