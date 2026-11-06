package server

import (
	"fmt"

	"phonepad/daemon/internal/filebatches"
)

// WithArrivalNotice shows a desktop notification each time the phone
// publishes a new batch. Replays of a stored batch do not notify again.
func WithArrivalNotice(show func(title, body string)) Option {
	return func(s *Server) { s.arrivalNotice = show }
}

func arrivalText(status filebatches.Status) (string, string) {
	title := fmt.Sprintf("Llegaron %d archivos", len(status.Files))
	body := "En Downloads/Phonepad/" + status.Folder
	if len(status.Files) == 1 {
		title = "Llegó " + status.Files[0].Name
	}
	return title, body
}

func (s *Server) noticeArrival(status filebatches.Status) {
	if s.arrivalNotice == nil || len(status.Files) == 0 {
		return
	}
	title, body := arrivalText(status)
	go s.arrivalNotice(title, body)
}
