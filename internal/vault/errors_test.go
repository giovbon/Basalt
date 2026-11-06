package vault

import (
	"errors"
	"testing"
)

// The web layer maps these sentinel kinds to HTTP status codes, so a change in
// the message text (or its translation) must not affect the status.
func TestMutationErrorsAreTyped(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)

	if err := v.SaveNote("exists.md", "# exists\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("target.md", "# target\n"); err != nil {
		t.Fatal(err)
	}
	if !v.CreateFolder("folder") {
		t.Fatal("CreateFolder(folder) = false")
	}
	if !v.CreateFolder("other") {
		t.Fatal("CreateFolder(other) = false")
	}

	tests := []struct {
		name string
		err  error
		want error
	}{
		{
			name: "move note from missing source",
			err:  v.MoveNote("missing.md", "new.md"),
			want: ErrSourceNotFound,
		},
		{
			name: "move note onto existing destination",
			err:  v.MoveNote("exists.md", "target.md"),
			want: ErrDestinationExists,
		},
		{
			name: "move note outside the vault",
			err:  v.MoveNote("../outside.md", "inside.md"),
			want: ErrInvalidPath,
		},
		{
			name: "move folder from missing source",
			err:  v.MoveFolder("missing", "new-folder"),
			want: ErrSourceNotFound,
		},
		{
			name: "move folder onto existing destination",
			err:  v.MoveFolder("folder", "other"),
			want: ErrDestinationExists,
		},
		{
			name: "delete missing folder",
			err:  v.DeleteFolder("missing"),
			want: ErrSourceNotFound,
		},
		{
			name: "delete vault root",
			err:  v.DeleteFolder("."),
			want: ErrInvalidPath,
		},
	}

	for _, tt := range tests {
		if tt.err == nil {
			t.Errorf("%s: got nil error, want %v", tt.name, tt.want)
			continue
		}
		if !errors.Is(tt.err, tt.want) {
			t.Errorf("%s: error = %v, want errors.Is(..., %v)", tt.name, tt.err, tt.want)
		}
	}
}
