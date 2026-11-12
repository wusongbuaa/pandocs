// Package pandocs is a typed client for the Pandocs API. Almost all of it is generated from the API description,
// which is why ClientWithResponses has one method for every operation.
//
//	client, err := pandocs.New("https://docs.example.com", token)
//	page, err := client.GetDocumentWithResponse(ctx, id, nil)
//	fmt.Println(page.JSON200.Data.Revision.No)
package pandocs

//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.2 -config oapi.yaml ../../docs/api/openapi.yaml

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
)

// New makes a client for a site, authenticating with an API token from an account page.
func New(server, token string, options ...ClientOption) (*ClientWithResponses, error) {
	authorize := WithRequestEditorFn(func(_ context.Context, request *http.Request) error {
		request.Header.Set("Authorization", "Bearer "+token)
		return nil
	})
	return NewClientWithResponses(strings.TrimRight(server, "/")+"/api/v1", append([]ClientOption{authorize}, options...)...)
}

// NewIdempotencyKey makes a value for the writes that ask for one. Sending a write again with the same key is safe: the
// server answers with what it answered the first time.
func NewIdempotencyKey() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw[:])
}
