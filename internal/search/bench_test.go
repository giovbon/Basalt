package search

import (
	"strings"
	"testing"
)

// benchNote builds ~8.8 KB of representative Portuguese prose: mostly ASCII
// with scattered accented runes, which is what takes foldNonASCII down its
// per-rune path in real vaults.
func benchNote() string {
	words := []string{
		"brasil", "nota", "descoberta", "história", "evento", "relato", "música",
		"livro", "estudo", "método", "sistema", "arquivo", "memória", "conversa",
		"encontro", "trabalho", "caminho", "ideia", "questão", "resposta",
		"pergunta", "coração", "não", "açúcar", "tradição", "exemplo", "cadeia",
		"pensamento", "projeto", "viagem", "cidade", "arquivos", "estudos",
	}
	var b strings.Builder
	for b.Len() < 8800 {
		for p := 0; p < 4; p++ {
			for s := 0; s < 4; s++ {
				var sentence []string
				for w := 0; w < 10; w++ {
					sentence = append(sentence, words[(b.Len()+w*7+s*13+p*3)%len(words)])
				}
				line := strings.Join(sentence, " ")
				b.WriteString(strings.ToUpper(line[:1]) + line[1:] + ". ")
			}
			b.WriteString("\n\n")
		}
	}
	return b.String()
}

var (
	benchText = benchNote()
	// Query present in most notes (worst case: extraction runs everywhere).
	benchQueryAll = Fold("nota")
	// Query absent from the note (fast-path reject case).
	benchQueryNone = Fold("zzqq")
)

func BenchmarkFoldContent(b *testing.B) {
	b.SetBytes(int64(len(benchText)))
	for i := 0; i < b.N; i++ {
		FoldContent(benchText)
	}
}

func BenchmarkSpansMatchAll(b *testing.B) {
	b.SetBytes(int64(len(benchText)))
	for i := 0; i < b.N; i++ {
		FoldedMatchSpansWithCount(benchText, benchQueryAll, 5)
	}
}

func BenchmarkSpansNoMatch(b *testing.B) {
	b.SetBytes(int64(len(benchText)))
	for i := 0; i < b.N; i++ {
		FoldedMatchSpansWithCount(benchText, benchQueryNone, 5)
	}
}
