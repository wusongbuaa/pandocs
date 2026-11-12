// Run against a stand-in for a server, so that all this shows is that the module as imported does what it says.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"

	pandocs "github.com/wusongbuaa/pandocs/sdks/go"
)

func main() {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"version":1,"data":[]}`)
	}))
	defer server.Close()
	client, err := pandocs.New(server.URL, "pd_try")
	if err != nil {
		log.Fatal(err)
	}
	answer, err := client.ListSpacesWithResponse(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	if answer.StatusCode() != 200 || authorization != "Bearer pd_try" {
		log.Fatalf("the module did not work: %d %q", answer.StatusCode(), authorization)
	}
	fmt.Println("the Go module works")
}
