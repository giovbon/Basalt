package vault

import "errors"

// Sentinel error kinds returned by the mutating vault operations.
//
// HTTP handlers map these to status codes with errors.Is, so the mapping no
// longer depends on the human-readable message (which is translated and shown
// to the user). Error() still returns the original text so existing API
// responses keep the same detail string.
var (
	ErrInvalidPath       = errors.New("invalid path")
	ErrSourceNotFound    = errors.New("source does not exist")
	ErrDestinationExists = errors.New("destination already exists")
	ErrOperationFailed   = errors.New("operation failed")
)

// OpError carries a user-facing message together with its sentinel kind.
type OpError struct {
	Kind error
	Msg  string
}

func (e *OpError) Error() string { return e.Msg }

func (e *OpError) Unwrap() error { return e.Kind }

func invalidPathError(msg string) error {
	return &OpError{Kind: ErrInvalidPath, Msg: msg}
}

func sourceNotFoundError(msg string) error {
	return &OpError{Kind: ErrSourceNotFound, Msg: msg}
}

func destinationExistsError(msg string) error {
	return &OpError{Kind: ErrDestinationExists, Msg: msg}
}

func operationFailedError(msg string) error {
	return &OpError{Kind: ErrOperationFailed, Msg: msg}
}
