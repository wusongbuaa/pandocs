package pandocs

import (
	"context"
	"net/http"
	"os"
	"testing"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Runs against a real server when given one. See packages/server/test/sdks.db.test.ts.
func TestAgainstARealServer(t *testing.T) {
	server, token, space := os.Getenv("PANDOCS_TEST_URL"), os.Getenv("PANDOCS_TEST_TOKEN"), os.Getenv("PANDOCS_TEST_SPACE")
	if server == "" {
		t.Skip("PANDOCS_TEST_URL is not set")
	}
	ctx := context.Background()
	client, err := New(server, token)
	if err != nil {
		t.Fatal(err)
	}

	me, err := client.GetMeWithResponse(ctx)
	if err != nil || me.JSON200 == nil {
		t.Fatalf("me: %v %s", err, me.Body)
	}

	markdown := "# From Go\n\nFirst paragraph.\n"
	title := "From Go"
	slug := "from-go"
	created, err := client.CreateDocumentWithResponse(ctx, space, CreateDocumentJSONRequestBody{Title: title, Slug: &slug, Markdown: &markdown})
	if err != nil || created.JSON201 == nil {
		t.Fatalf("create: %v %s", err, created.Body)
	}
	id := openapi_types.UUID(created.JSON201.Data.Document.Id)

	page, err := client.GetDocumentWithResponse(ctx, id, nil)
	if err != nil || page.JSON200 == nil {
		t.Fatalf("read: %v %s", err, page.Body)
	}
	if page.JSON200.Data.Revision.No != 1 || page.JSON200.Data.Document.Title != title {
		t.Fatalf("read back %+v", page.JSON200.Data)
	}

	saved, err := client.SaveDocumentContentWithResponse(ctx, id, &SaveDocumentContentParams{IdempotencyKey: NewIdempotencyKey()}, SaveDocumentContentJSONRequestBody{Markdown: "# From Go\n\nChanged.\n", ExpectedRevision: 1})
	if err != nil || saved.JSON200 == nil {
		t.Fatalf("save: %v %s", err, saved.Body)
	}
	if saved.JSON200.Data.Revision.No != 2 {
		t.Fatalf("saved %+v", saved.JSON200.Data)
	}

	conflict, err := client.SaveDocumentContentWithResponse(ctx, id, &SaveDocumentContentParams{IdempotencyKey: NewIdempotencyKey()}, SaveDocumentContentJSONRequestBody{Markdown: "stale", ExpectedRevision: 1})
	if err != nil || conflict.StatusCode() != http.StatusConflict {
		t.Fatalf("a stale save should be refused: %v %d %s", err, conflict.StatusCode(), conflict.Body)
	}
}
