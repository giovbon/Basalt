package web

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"notediscovery/internal/vault"
)

func TestStatusForVaultError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"invalid path", fmt.Errorf("move: %w", &vault.OpError{Kind: vault.ErrInvalidPath, Msg: "Invalid source path"}), http.StatusBadRequest},
		{"missing source", &vault.OpError{Kind: vault.ErrSourceNotFound, Msg: "Source note does not exist"}, http.StatusNotFound},
		{"existing destination", &vault.OpError{Kind: vault.ErrDestinationExists, Msg: "A note already exists"}, http.StatusConflict},
		{"io failure", &vault.OpError{Kind: vault.ErrOperationFailed, Msg: "rename failed"}, http.StatusInternalServerError},
		{"unknown error", errors.New("boom"), http.StatusInternalServerError},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := statusForVaultError(tt.err); got != tt.want {
				t.Errorf("statusForVaultError(%v) = %d, want %d", tt.err, got, tt.want)
			}
		})
	}
}
