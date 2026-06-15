package api

import (
	"context"
	"net/http"

	"github.com/ArielFalcon/panchito/internal/contract"
)

// Login exchanges a GitHub user token (obtained via the device flow in internal/auth) for a
// server session. It is an UNauthenticated call — the GitHub token is the credential — so it
// works on a Client built with an empty bearer token. The returned session JWT is what the
// caller then stores and sends as the Authorization bearer on every subsequent request.
func (c *Client) Login(ctx context.Context, githubToken string) (contract.LoginResponse, error) {
	var out contract.LoginResponse
	err := c.do(ctx, http.MethodPost, "/api/v1/auth/login", contract.LoginRequest{GithubToken: githubToken}, &out)
	return out, err
}
