# Pandocs client for Go

Generated from the API description, with one method for every operation.

```go
client, err := pandocs.New("https://docs.example.com", token)
if err != nil {
	return err
}
page, err := client.GetDocumentWithResponse(ctx, id, nil)
if err != nil {
	return err
}
fmt.Println(page.JSON200.Data.Revision.No)

saved, err := client.SaveDocumentContentWithResponse(ctx, id,
	&pandocs.SaveDocumentContentParams{IdempotencyKey: pandocs.NewIdempotencyKey()},
	pandocs.SaveDocumentContentJSONRequestBody{Markdown: edited, ExpectedRevision: page.JSON200.Data.Revision.No})
```

Regenerate with `scripts/generate-sdks.sh` from the repository root. Do not edit `client.gen.go`.
