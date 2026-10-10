package server

import (
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"time"
)

const mediaSnapshotTTL = 30 * time.Second
const maxSafeMediaEpoch = 1<<53 - 1

type mediaSource struct {
	State  string `json:"state"`
	ID     string `json:"id,omitempty"`
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
}
type mediaGeometry struct {
	State         string `json:"state"`
	Epoch         uint64 `json:"epoch,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	EncodedWidth  int    `json:"encodedWidth,omitempty"`
	EncodedHeight int    `json:"encodedHeight,omitempty"`
	Reason        string `json:"reason,omitempty"`
}
type mediaVideo struct {
	State         string   `json:"state"`
	Codecs        []string `json:"codecs,omitempty"`
	SelectedCodec string   `json:"selectedCodec,omitempty"`
	Reason        string   `json:"reason,omitempty"`
}
type mediaSnapshot struct {
	Version  int           `json:"version"`
	Source   mediaSource   `json:"source"`
	Geometry mediaGeometry `json:"geometry"`
	Video    mediaVideo    `json:"video"`
}
type mediaObservation struct {
	next     uint64
	applied  uint64
	snapshot mediaSnapshot
	observed time.Time
	// Missing caps during renegotiation must not erase the last proven epoch.
	knownSource   string
	knownGeometry mediaGeometry
}

var mediaCodecPattern = regexp.MustCompile(`^[A-Z0-9]{2,16}$`)

func unknownMedia(reason string) mediaSnapshot {
	return mediaSnapshot{Version: 1, Source: mediaSource{State: "unknown", Reason: reason},
		Geometry: mediaGeometry{State: "unknown", Reason: reason}, Video: mediaVideo{State: "unknown", Reason: reason}}
}

func validMediaState(state string) bool {
	return state == "available" || state == "unavailable" || state == "unknown"
}

func parseMediaSnapshot(data json.RawMessage) (mediaSnapshot, error) {
	var value mediaSnapshot
	invalid := errors.New("invalid media capabilities")
	if len(data) == 0 || string(data) == "null" || len(data) > 8192 || json.Unmarshal(data, &value) != nil || value.Version != 1 {
		return value, invalid
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	for part, optional := range map[string][]string{
		"source":   {"id", "kind", "reason"},
		"geometry": {"epoch", "width", "height", "encodedWidth", "encodedHeight", "reason"},
		"video":    {"codecs", "selectedCodec", "reason"},
	} {
		var object map[string]json.RawMessage
		if json.Unmarshal(fields[part], &object) != nil {
			return value, invalid
		}
		for _, key := range optional {
			if raw, present := object[key]; present && string(raw) == "null" {
				return value, invalid
			}
		}
		var state string
		_ = json.Unmarshal(object["state"], &state)
		if state != "available" {
			for _, key := range optional {
				if key != "kind" && key != "reason" {
					if _, present := object[key]; present {
						return value, invalid
					}
				}
			}
		}
	}
	if !validMediaState(value.Source.State) || !validMediaState(value.Geometry.State) || !validMediaState(value.Video.State) ||
		len(value.Source.Reason) > 128 || len(value.Geometry.Reason) > 128 || len(value.Video.Reason) > 128 || len(value.Source.Kind) > 32 {
		return value, invalid
	}
	if value.Source.State == "available" {
		if value.Source.ID == "" || !validSessionEpoch(value.Source.ID) {
			return value, invalid
		}
	} else if value.Source.ID != "" {
		return value, invalid
	}
	g := value.Geometry
	if g.State == "available" {
		if value.Source.State != "available" || g.Epoch < 1 || g.Epoch > maxSafeMediaEpoch {
			return value, invalid
		}
		for _, dimension := range []int{g.Width, g.Height, g.EncodedWidth, g.EncodedHeight} {
			if dimension < 1 || dimension > 32768 {
				return value, invalid
			}
		}
	} else if g.Epoch != 0 || g.Width != 0 || g.Height != 0 || g.EncodedWidth != 0 || g.EncodedHeight != 0 {
		return value, invalid
	}
	if len(value.Video.Codecs) > 8 || (value.Video.State == "available" && len(value.Video.Codecs) == 0) || (value.Video.State != "available" && (len(value.Video.Codecs) != 0 || value.Video.SelectedCodec != "")) {
		return value, invalid
	}
	seen := make(map[string]bool)
	for _, codec := range value.Video.Codecs {
		if !mediaCodecPattern.MatchString(codec) || seen[codec] {
			return value, invalid
		}
		seen[codec] = true
	}
	if value.Video.SelectedCodec != "" && !seen[value.Video.SelectedCodec] {
		return value, invalid
	}
	return value, nil
}

// Status requests can open the Portal picker. Never issue one while merely
// connecting a trackpad. Cache only responses the viewer already requested.
func (s *Server) beginMediaObservation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.media.next++
	return s.media.next
}

func (s *Server) mediaSnapshotLocked() mediaSnapshot {
	if s.media.observed.IsZero() || time.Since(s.media.observed) > mediaSnapshotTTL {
		return unknownMedia("query_preview_status")
	}
	return s.media.snapshot
}

func (s *Server) observeMedia(sequence uint64, next mediaSnapshot, sessionEpoch ...string) error {
	s.mu.Lock()
	if len(sessionEpoch) > 0 && sessionEpoch[0] != "" && sessionEpoch[0] != s.sessionEpoch {
		s.mu.Unlock()
		return nil
	}
	if sequence <= s.media.applied {
		s.mu.Unlock()
		return nil
	}
	previous := s.media.knownGeometry
	if next.Source.ID != "" && next.Source.ID == s.media.knownSource && previous.State == "available" && next.Geometry.State == "available" {
		if next.Geometry.Epoch < previous.Epoch ||
			(next.Geometry.Epoch == previous.Epoch && next.Geometry != previous) {
			s.mu.Unlock()
			return errors.New("media geometry epoch reused")
		}
	}
	changed := !reflect.DeepEqual(s.mediaSnapshotLocked(), next)
	s.media.applied, s.media.snapshot, s.media.observed = sequence, next, time.Now()
	if next.Source.State == "available" {
		if next.Source.ID != s.media.knownSource {
			s.media.knownSource = next.Source.ID
			s.media.knownGeometry = mediaGeometry{}
		}
		if next.Geometry.State == "available" {
			s.media.knownGeometry = next.Geometry
		}
	}
	if !changed {
		s.mu.Unlock()
		return nil
	}
	s.capabilityRevision++
	c := s.current
	data, revision := s.capabilitiesMessageLocked()
	s.mu.Unlock()
	s.sendCapabilityUpdate(c, data, revision)
	return nil
}
