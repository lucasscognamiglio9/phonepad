package privatefs

import (
	"os"
	"regexp"
	"strings"

	"golang.org/x/sys/windows"
)

var aceSID = regexp.MustCompile(`\([^()]*;;;([^()]+)\)`)

func userSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// Secure protects a file or directory with a non-inherited DACL granting
// access only to the signed-in user and Local System. Directory ACEs inherit
// to newly created children, including temporary files before publication.
func Secure(path string, directory bool) error {
	sid, err := userSID()
	if err != nil {
		return err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";GA;;;" + sid + ")(A;" + flags + ";GA;;;SY)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

func IsPrivate(path string, directory bool) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if directory != info.IsDir() {
		return false, nil
	}
	sid, err := userSID()
	if err != nil {
		return false, err
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	sddl := sd.String()
	if !strings.Contains(sddl, "D:P") {
		return false, nil
	}
	aces := aceSID.FindAllStringSubmatch(sddl, -1)
	if len(aces) == 0 {
		return false, nil
	}
	for _, ace := range aces {
		if ace[1] != sid && ace[1] != "SY" && ace[1] != "S-1-5-18" {
			return false, nil
		}
	}
	return true, nil
}
