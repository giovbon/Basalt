package web

import (
	"errors"
	"net/http"

	"notediscovery/internal/vault"
)

// statusForVaultError maps the sentinel errors returned by vault mutations to
// HTTP status codes. Handlers must use errors.Is rather than matching the
// human-readable message, which is translated and free to change.
func statusForVaultError(err error) int {
	switch {
	case errors.Is(err, vault.ErrInvalidPath):
		return http.StatusBadRequest
	case errors.Is(err, vault.ErrSourceNotFound):
		return http.StatusNotFound
	case errors.Is(err, vault.ErrDestinationExists):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}
