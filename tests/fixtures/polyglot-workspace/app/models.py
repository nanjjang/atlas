from django.db import models


class Team(models.Model):
    name = models.CharField(max_length=100)


class Member(models.Model):
    team = models.ForeignKey(Team, on_delete=models.CASCADE)
